'use strict'

import pino from 'pino'
import {strictEqual, ok} from 'node:assert'
import {EventEmitter} from 'node:events'
import {createServer as createHttpServer} from 'node:http'
import {x} from 'xastscript'
import {CLIENT_CALLS, SERVER_CALLS, ALL_CALLS} from './lib/calls.js'
import {createSendRequest, BESTAETIGUNG,} from './lib/send-request.js'
import {createServer} from './lib/server.js'
import {SERVICES} from './lib/services.js'
import {getZst} from './lib/zst.js'
import {parseAusIstFahrt} from './lib/parse-aus-istfahrt.js'

const {
	DFI,
	// REF_DFI,
	// ANS,
	// REF_ANS,
	// > Dieser Dienst wird derzeit nicht von der VBB Datendrehscheibe unterstützt.
	// VIS,
	// > Dieser Dienst wird derzeit nicht von der VBB Datendrehscheibe unterstützt.
	// AND,
	AUS,
	// REF_AUS,
} = SERVICES
const {
	STATUS,
	ABO_VERWALTEN,
	DATEN_ABRUFEN,
} = CLIENT_CALLS
const {
	CLIENT_STATUS,
	DATEN_BEREIT,
} = SERVER_CALLS

// > 5.1.2.1 Abonnementsanfrage (AboAnfrage)
// > Definition AboAnfrage:
// > […]
// > AboASBRef: […] Abonniert Referenzdaten für die Anschlusssicherung.
// > AboASB: […] Abonniert Prozessdaten für die Anschlusssicherung.
// > AboAZBRef: […] Abonniert Referenzdaten für die Fahrgastinformation.
// > AboAZB: […] Abonniert Prozessdaten für die Fahrgastinformation.
// > AboVIS: […] Abonniert Prozessdaten für die Visualisierung.
// > AboAND: […] Abonniert Prozessdaten des Nachrichtendienstes.
// > […]
const ABO_ANFRAGE_ROOT_SUB_TAGS_BY_SERVICE = new Map([
	[DFI, 'AboAZB'],
	// [REF_DFI, 'AboAZBRef'],
	[AUS, 'AboAUS'],
	// [REF_AUS, 'AboAUSRef'],
])

// > 5.1.4.2 Daten übertragen (DatenAbrufenAntwort)
// > Definition DatenAbrufenAntwort:
// > […]
// > Zubringernachricht: […] Enthält Nachrichten des Zubringers im Dienst Anschlusssicherung.
// > Abbringernachricht: […] Enthält Nachrichten des Abbringers im Dienst Anschlusssicherung.
// > AZBNachricht: […] Enthält Nachrichten über auf einen Anzeigebereich zulaufende Fremdfahrzeuge.
// > VISNachricht: […] Enthält Informationen zu Fahrten, die in einer Fremdleitstelle visualisiert werden sollen.
// > ANDNachricht: […] Enthält Informationen zu aktuellen Betriebsereignissen, die in einer Fremdleitstelle einem Disponenten mitgeteilt werden sollen.
// > […]
// VDV 454 spec:
// > 5.1.2 Daten übermitteln (AUSNachricht)
// > Alle Datenübermittlungen zu einem Abonnement (Planungdaten, Istdaten und Anschlussinformationen) werden in dem Element AUSNachricht übermittelt.
const DATEN_ABRUFEN_ANTWORT_ROOT_SUB_TAGS_BY_SERVICE = new Map([
	[DFI, 'AZBNachricht'],
	// [REF_DFI, 'AZBNachricht'],
	// todo: rather pick AUSNachricht children (FahrtVerband, Linienfahrplan, SollUmlauf, IstFahrt, IstUmlauf, GesAnschluss)? – AUSNachricht has ~500kb of children, so this would lead to smaller XML trees being read into memory
	[AUS, 'AUSNachricht'],
	// [REF_AUS, 'AUSNachricht'],
])

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

// This implementation follows the VDV 453 spec, as documented in the "VDV-453 Ist-Daten-Schnittstelle – Version 2.6.1" document. It also supports the VDV 454 extension, as documented in the "VDV-454 Ist-Daten-Schnittstelle – Fahrplanauskunft – Version 2.2.1".
// https://web.archive.org/web/20231208122259/https://www.vdv.de/vdv-schrift-453-v2.6.1-de.pdfx?forced=true
// https://web.archive.org/web/20231208122259/https://www.vdv.de/454v2.2.1-sd.pdfx?forced=true
// see also https://web.archive.org/web/20231208122259/https://www.vdv.de/i-d-s-downloads.aspx

const createClient = (cfg, opt = {}) => {
	const {
		leitstelle,
	} = cfg
	strictEqual(typeof leitstelle, 'string', 'cfg.leitstelle must be a string')
	ok(leitstelle, 'cfg.leitstelle must not be empty')

	const {
		logger,
	} = {
		logger: pino({
			level: process.env.LOG_LEVEL || 'info',
		}),
		...opt,
	}
	ok('object' === typeof logger && logger, 'opt.logger must be an object')
	cfg = {
		...cfg,
		logger,
	}

	const sendRequest = createSendRequest({
		...cfg,
		// separate logger for network requests, they are too noisy usually
		logger: pino({
			level: process.env.LOG_LEVEL_REQUESTS || 'info',
			// todo: remove some fields from logs, e.g.
			// - clientRequest.agent
			// - clientRequest.res
			// - serverResponse._readableState
			// - serverResponse.client
			// - serverResponse.req
		}),
	}, opt)
	const {router, errorHandler} = createServer(cfg, opt)

	// todo: serve basic information about the service on /

	const data = new EventEmitter()

	// ----------------------------------

	const startDienstZst = getZst()

	// Technically, we don't need globally unique subscription IDs.
	// > 5.1.1 Überblick
	// > Eine AboID ist innerhalb eines jeden Dienstes eindeutig.
	// todo: persist counter across client restarts, or append random characters? (according to the xsd, AboID must be an integer)
	const getNextAboId = () => String(10000 + Math.round(Math.random() * 9999))
	// service -> set of AboIDs
	const subscriptions = Object.fromEntries(
		SERVICES.map(svc => [svc, new Set()]),
	)

	// todo: make configurable with a decent UX
	const datensatzAlle = false

	// todo: move to lib/server.js?
	const _onRequest = (service, call, handleRequest) => {
		const path = '/' + [leitstelle, service, call].map(part => encodeURIComponent(part)).join('/')
		// todo: debug-log
		router.post(path, async (req, res, next) => {
			try {
				await handleRequest(req, res, next)
			} catch (err) {
				next(err)
			}
		})
	}

	const _handleClientStatusAnfrage = (service) => {
		_onRequest(service, CLIENT_STATUS, async (req, res) => {
			const logCtx = {
				service,
			}

			const clientStatusAnfrage = await req.parseWholeRoot('ClientStatusAnfrage')
			logCtx.clientStatusAnfrage = clientStatusAnfrage
			logger.debug(logCtx, 'received ClientStatusAnfrage')

			// todo: expose value of `StartDienstZst` child?
			// todo: expose value of `DatenVersionID` child?

			res.respondWithResponse({
				ok: true, // todo: are we ever not okay?
				status: true, // send Status element
				children: [
					x('StartDienstZst', {}, startDienstZst),
					// todo: provide AktiveAbos if `clientStatusAnfrage.$.MitAbos` has value `true`
					// > 5.1.8.3 ClientStatusAnfrage
					// > Beispiel 3: Antwort des Clients: Dienst verfügbar, Client initialisiert gerade und will keine Auskunft zu den aktiven Abonnements geben:
				],
			})
		})
	}

	const _sendStatusAnfrage = async (service) => {
		const {
			parseResponse,
			assertStatusAntwortOk,
		} = await sendRequest(
			service,
			STATUS,
			// todo: move "StatusAnfrage" into constant?
			'StatusAnfrage',
			[],
		)

		const tags = parseResponse([
			// todo: move "StatusAntwort" into constant?
			{tag: 'StatusAntwort', preserve: true},
		])
		for await (const [tag, el] of tags) {
			if (tag === 'StatusAntwort') {
				assertStatusAntwortOk(el)

				logger.debug({
					service,
					statusAntwort: el,
				}, 'received StatusAntwort')
				return el
			}
			// todo: otherwise warn-log unexpected tag?
		}
	}

	// ----------------------------------

	const _sendAboAnfrage = async (service, aboParams) => {
		// todo: validate arguments
		const {
			parseResponse,
			assertBestaetigungOk,
		} = await sendRequest(
			service,
			ABO_VERWALTEN,
			// todo: move "AboAnfrage" into constant?
			'AboAnfrage',
			aboParams,
		)

		const tags = parseResponse([
			{tag: BESTAETIGUNG, preserve: true},
		])
		for await (const [tag, el] of tags) {
			if (tag === BESTAETIGUNG) {
				assertBestaetigungOk(el)
				return el
			}
			// todo: otherwise warn-log unexpected tag?
		}
	}

	const _subscribe = async (service, aboSubChildren, expiresAt) => {
		// todo: validate arguments
		ok(
			ABO_ANFRAGE_ROOT_SUB_TAGS_BY_SERVICE.has(service),
			`invalid/unknown tag of root sub element for service "${service}"`
		)
		const aboSubTag = ABO_ANFRAGE_ROOT_SUB_TAGS_BY_SERVICE.get(service)

		const aboId = getNextAboId()
		const logCtx = {
			service,
			aboId,
			aboSubTag,
			aboSubChildren,
		}
		logger.debug(logCtx, 'subscribing to items')

		const aboParams = [
			x(aboSubTag, {
				AboID: aboId,
				VerfallZst: getZst(expiresAt),
			}, aboSubChildren)
		]

		// keep track of the subscription using the `aboID`
		// We do this before sending the request because we might crash while the request is in-flight.
		// todo: do this after the request has been sent?
		subscriptions[service].add(aboId)

		const bestaetigung = await _sendAboAnfrage(
			service,
			aboParams,
		)
		logCtx.bestaetigung = bestaetigung

		logger.debug(logCtx, 'successfully subscribed to items')
		return {
			aboId,
		}
	}

	const _unsubscribe = async (service, aboIds) => {
		const logCtx = {
			service,
			aboIds,
		}
		logger.debug(logCtx, 'unsubscribing from subscriptions')

		const aboParams = aboIds.map(aboId => x('AboLoeschen', {}, aboId))
		const bestaetigung = await _sendAboAnfrage(
			service,
			aboParams,
		)
		logCtx.bestaetigung = bestaetigung

		for (const aboId of aboIds) {
			subscriptions[service].delete(aboId)
		}
		logger.debug(logCtx, 'successfully unsubscribed from subscriptions')
	}

	const _unsubscribeAll = async (service) => {
		const logCtx = {
			service,
		}
		logger.debug(logCtx, 'unsubscribing from all subscriptions')

		const aboParams = [
			x('AboLoeschenAlle', {}, 'true'),
		]
		const bestaetigung = await _sendAboAnfrage(
			service,
			aboParams,
		)
		logCtx.bestaetigung = bestaetigung

		subscriptions[service].clear()
		logger.debug(logCtx, 'successfully unsubscribed from all subscriptions')
	}

	const _handleDatenBereitAnfrage = (service, onDatenBereit) => {
		_onRequest(service, DATEN_BEREIT, async (req, res) => {
			const logCtx = {
				service,
			}

			const datenBereitAnfrage = await req.parseWholeRoot('datenBereitAnfrage')
			logCtx.datenBereitAnfrage = datenBereitAnfrage
			logger.debug(logCtx, 'received datenBereitAnfrage')

			res.respondWithResponse({
				// todo: are we ever not okay? what if there are 0 subscriptions for this service?
				ok: true,
				bestaetigung: true, // send Bestaetigung element
			})
			onDatenBereit()
		})
	}

	// todo:
	// > 5.1.4.1 Datenübertragung anfordern (DatenAbrufenAnfrage)
	// > Wurde bereits eine DatenAbrufenAnfrage vom Client an den Server versandt, so ist für diese vom Client eine DatenAbrufenAntwort abzuwarten (Antwort, oder Timeout), bevor erneut eine DatenAbrufenAnfrage versandt wird. Es wird daher empfohlen keine weitere DatenAbrufenAnfrage zu stellen, solange noch eine DatenAbrufenAnfrage aktiv ist.
	const WEITERE_DATEN = 'WeitereDaten'
	const DATEN_ABRUFEN_MAX_RECURSIONS = 300
	const _sendDatenAbrufenAnfrage = async function* (service, opt = {}, recursionLevel = 0) {
		opt = {
			datensatzAlle: false,
			...opt,
		}
		const {
			datensatzAlle,
		} = opt
		if (recursionLevel >= DATEN_ABRUFEN_MAX_RECURSIONS) {
			const err = new Error(`${service}: too many recursions while fetching data`)
			err.service = service
			err.datensatzAlle = datensatzAlle
			err.recursions = recursionLevel
			throw err
		}

		ok(
			DATEN_ABRUFEN_ANTWORT_ROOT_SUB_TAGS_BY_SERVICE.has(service),
			`invalid/unknown tag of DatenAbrufenAntwort sub element(s) for service "${service}"`
		)
		const dataSubTag = DATEN_ABRUFEN_ANTWORT_ROOT_SUB_TAGS_BY_SERVICE.get(service)

		const logCtx = {
			service,
			dataSubTag,
			recursionLevel,
		}
		logger.trace(logCtx, 'requesting data')

		const {
			parseResponse,
			assertBestaetigungOk,
		} = await sendRequest(
			service,
			DATEN_ABRUFEN,
			// todo: move "DatenAbrufenAnfrage" into constant?
			'DatenAbrufenAnfrage',
			[
				// > 5.1.4.2.1 Handhabung DatensatzAlle
				// > Bei DatenAbrufenAnfrage mit `DatensatzAlle=true` werden folgende Daten gesendet:
				// > - Bei allen Diensten muss es das Ziel sein, dass ein Datenkonsument im Prinzip alle bisher empfangenen Daten löschen und durch die neu empfangenen Daten ersetzen kann.
				// > - Es werden alle Daten gesendet, welche die Bedingungen der aktiven Abos erfüllen.
				// > - Bei den Referenzdiensten werden alle Daten des in der `AboAnfrage` abonnierten Zeitbereiches möglichst nochmals komplett gesendet. Ist der Datenlieferant dazu nicht mehr in der Lage, signalisiert er dies mittels angepassten Zeitfenstern in den Linienfahrplänen (REF-ANS: 6.2.3.3.2; REF-DFI: 6.3.7.3.2; REF-AUS: 5.1.3). Falls ein Datenlieferant eine `DatenAbrufenAnfrage` erhält, die Daten aber noch nicht bereit hat, soll eine leere `DatenAbrufenAntwort` (das verpflichtende Element `Bestaetigung` ist enthalten, das optionale Element `Zubringernachicht`/`AZBNachricht`/`AUSNachricht` fehlt jedoch) gesendet werden. Der Datenkonsument darf in diesem Fall keine Rückschlüsse auf irgendwelche Linienfahrpläne ziehen, weil die Antwort darüber nichts aussagt.
				// > - Beim ANS werden zusätzlich noch `ASBFahrplanlagen` (s. 6.2.3.1.1 `ASBZubringer`-Meldungsart) für alle Zubringer gesendet, welche bereits angekommen sind, aber deren `VerfallZst` noch nicht abgelaufen ist (falls die Partner keine andere Dauer vereinbaren). Darunter können auch Ankunftsmeldungen für Zubringer sein, welche den Anschlussbereich bereits wieder verlassen haben, deren Umsteiger jedoch noch immer unterwegs zu einem Abbringer sein könnten, welcher für sie zurückgehalten werden muss.
				// > - Folgende Meldungen, die über reine Fahrplanlagen hinausgehen, sollten nochmals gesendet werden (möglichst komplett, damit die Daten auf die allenfalls vorhandenen Solldaten abgebildet werden können):
				// > 	- `AZBFahrplanlage` der `AZBMeldungsart` `BereichVerlassen` für verfrüht abgefahrene Fahrten, wo Soll noch nicht erreicht ist,
				// > 	- Meldungen der Meldungsart `Ausfall` bzw. `AbbringerFahrtLoeschen` (wenn möglich mit Ursache) für ausgefallene Fahrten im Rahmen der Gültigkeit des aktiven Abos.
				x('DatensatzAlle', {}, datensatzAlle + ''),
			],
		)

		const tags = parseResponse([
			{tag: BESTAETIGUNG, preserve: true},
			{tag: WEITERE_DATEN, preserve: true},
			{tag: dataSubTag, preserve: true},
		])
		let weitereDaten = false
		for await (const [tag, el] of tags) {
			if (tag === BESTAETIGUNG) {
				assertBestaetigungOk(el)
				logCtx.bestaetigung = el
				continue
			}
			if (tag === WEITERE_DATEN) {
				if (el.$text !== 'true') continue;
				// > 5.1.4.2 Daten übertragen (DatenAbrufenAntwort)
				// > Der Server antwortet mit den aktualisierten Datensätzen innerhalb einer Nachricht vom Typ `DatenAbrufenAntwort`. Der Inhalt ist dienstspezifisch.
				// > Mittels des Elementes `WeitereDaten` wird angezeigt, ob der Inhalt von `DatenAbrufenAntwort` alle aktualisierten Daten enthält, oder ob aus technischen Gründen die Übermittlung in mehrere Pakete aufgeteilt wurde. Diese Daten können durch den Datenkonsumenten durch weitere `DatenAbrufenAnfrage`n beim Produzenten abholt werden. Beim letzten Datenpaket ist das Element `WeitereDaten` auf `false` gesetzt. Abweichend vom Standardverhalten optionaler Felder hat `WeitereDaten` den Default-Wert `false`. Ein fehlendes Element `WeitereDaten` zeigt also an, dass die Datenübertragung vollständig mit diesem Paket abgeschlossen wird.
				weitereDaten = true
			}
			if (tag === dataSubTag) {
				yield el
				continue
			}
			// todo: otherwise warn-log unexpected tag?
		}

		if (weitereDaten) {
			logger.debug(logCtx, `received DatenAbrufenAntwort with WeitereDaten=true, recursing (${recursionLevel + 1})`)
			yield* _sendDatenAbrufenAnfrage(service, opt, recursionLevel + 1)
		}
	}

	// ----------------------------------

	_handleClientStatusAnfrage(DFI)
	// _handleClientStatusAnfrage(REF_DFI)
	// _handleClientStatusAnfrage(ANS)
	// _handleClientStatusAnfrage(REF_ANS)
	// _handleClientStatusAnfrage(VIS)
	// _handleClientStatusAnfrage(AND)
	_handleClientStatusAnfrage(AUS)
	// _handleClientStatusAnfrage(REF_AUS)

	// ----------------------------------

	const dfiSubscribe = async (azbId, opt = {}) => {
		const {
			expiresAt,
			linienId,
			richtungsId,
			vorschauzeit,
			hysterese,
		} = {
			expiresAt: Date.now() + HOUR,
			linienId: null,
			richtungsId: null,
			vorschauzeit: 10, // minutes
			// todo: is `0` possible? does it provide more data?
			hysterese: 1, // seconds
			...opt,
		}
		// todo: validate arguments

		const aboSubChildren = [
			x('AZBID', {}, azbId),
			x('LinienFilter', {}, [
				linienId !== null ? x('LinienID', {}, linienId) : null,
				richtungsId !== null ? x('RichtungsID', {}, richtungsId) : null,
			]),
			x('Vorschauzeit', {}, vorschauzeit),
			x('Hysterese', {}, hysterese),
			// todo: MaxAnzahlFahrten
			// todo: MaxTextLaenge
			// todo: NurAktualisierung
		]
		return await _subscribe(DFI, aboSubChildren, expiresAt)
	}
	const dfiUnsubscribe = async (...aboIds) => {
		return await _unsubscribe(DFI, aboIds)
	}
	const dfiUnsubscribeAll = async () => {
		return await _unsubscribeAll(DFI)
	}

	_handleDatenBereitAnfrage(DFI, async () => {
		// _handleDatenBereitAnfrage does not handle rejections, so we do it here
		try {
			const els = _sendDatenAbrufenAnfrage(DFI, datensatzAlle)
			for await (const azbNachricht of els) {
				// todo: additionally emit azbNachricht.$children?
				data.emit(`raw:${DFI}:AZBNachricht`, azbNachricht)
			}
		} catch (err) {
			// todo: emit error on `dfiData` somehow?
			logger.error({
				service: DFI,
				err,
			}, `failed to fetch data: ${err.message}`)
		}
	})

	// ----------------------------------

	const ausSubscribe = async (opt = {}) => {
		const {
			expiresAt,
			// linienId,
			// richtungsId,
			vorschauzeit,
			hysterese,
		} = {
			expiresAt: Date.now() + HOUR,
			// linienId: null,
			// richtungsId: null,
			vorschauzeit: 10, // minutes
			// The VBB VDV-453 server reports:
			// > Die Hysterese des Lieferanten "VBB DDS" ist 60 Sekunden […].
			hysterese: 60, // seconds
			...opt,
		}
		// todo: validate arguments

		const aboSubChildren = [
			// todo: LinienFilter doesn't seem to work yet
			// x('LinienFilter', {}, [
			// 	linienId !== null ? x('LinienID', {}, linienId) : null,
			// 	richtungsId !== null ? x('RichtungsID', {}, richtungsId) : null,
			// ]),
			x('Hysterese', {}, hysterese),
			// todo: BetreiberFilter
			// todo: ProduktFilter
			// todo: VekehrsmittelTextFilter
			// todo: HaltFilter
			// todo: UmlaufFilter
			// todo: MitGesAnschluss
			// todo: MitRealZeiten
			// todo: MitFormation
			// todo: NurAktualisierung
			// Note: <Vorschauzeit> has to be the last child element!
			x('Vorschauzeit', {}, vorschauzeit),
		]
		return await _subscribe(AUS, aboSubChildren, expiresAt)
	}
	const ausUnsubscribe = async (...aboIds) => {
		return await _unsubscribe(AUS, aboIds)
	}
	const ausUnsubscribeAll = async () => {
		return await _unsubscribeAll(AUS)
	}

	const _fetchNewAusData = async () => {
		try {
			const els = _sendDatenAbrufenAnfrage(AUS, datensatzAlle)
			for await (const ausNachricht of els) {
				data.emit(`raw:${AUS}:AUSNachricht`, ausNachricht)
				for (const child of ausNachricht.$children) {
					// e.g. `raw:aus:IstFahrt`
					data.emit(`raw:${AUS}:${child.$name}`, child)
					if (child.$name === 'IstFahrt') {
						const istFahrt = parseAusIstFahrt(child)
						data.emit(`${AUS}:IstFahrt`, istFahrt)
					}
				}
			}
		} catch (err) {
			// todo: emit error on `ausData` somehow?
			logger.error({
				service: AUS,
				err,
			}, `failed to fetch & process data: ${err.message}`)
		}
	})

	// ----------------------------------

	router.use(errorHandler)

	const httpServer = createHttpServer((req, res) => {
		const final = () => {
			// The `createServer()` should always have responded already, on both failures and successful handling.
			ok(res.headersSent, `router did not handle the request (${req.method} ${req.url})`)
		}
		router(req, res, final)
	})
	return {
		logger,
		sendRequest,
		httpServer,
		data,
		dfiSubscribe,
		dfiUnsubscribe,
		dfiUnsubscribeAll,
		ausSubscribe,
		ausUnsubscribe,
		ausUnsubscribeAll,
	}
}

export {
	SERVICES,
	CLIENT_CALLS, SERVER_CALLS, ALL_CALLS,
	createClient,
}
