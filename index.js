'use strict'

import pino from 'pino'
import {strictEqual, ok} from 'node:assert'
import {EventEmitter} from 'node:events'
import {createServer as createHttpServer} from 'node:http'
import {x} from 'xastscript'
import {CLIENT_CALLS, SERVER_CALLS, ALL_CALLS} from './lib/calls.js'
import {openInMemoryStorage} from './lib/in-memory-storage.js'
import {
	createSendRequest,
	BESTAETIGUNG,
	Vdv453HttpError, Vdv453ApiError,
} from './lib/send-request.js'
import {createServer} from './lib/server.js'
import {SERVICES} from './lib/services.js'
import {isProgrammerError} from './lib/is-programmer-error.js'
import {getZst} from './lib/zst.js'
import {
	PARSED_LINIENFAHRPLAN_CHILDREN,
	parseRefAusSollFahrt,
} from './lib/parse-ref-aus-sollfahrt.js'
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
	REF_AUS,
	AUS,
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
	[REF_AUS, 'AboAUSRef'],
	[AUS, 'AboAUS'],
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
	// Because a single AUSNachricht may have (unpredictably) much data (with the VBB API it usually is at most ~1mb, but we can't rely on that), we only parse its children (i.e. Linienfahrplan) into XML trees.
	// todo: how to handle other AUSNachricht children: SollUmlauf, FahrtVerband, GesAnschluss?
	// todo: parse AUSNachricht.AboID and expose it?
	// todo:
	// > Falls ein Datenlieferant eine DatenAbrufenAnfrage erhält, die Daten aber noch nicht bereit hat, soll eine leere DatenAbrufenAntwort (das verpflichtende Element Bestaetigung ist enthalten, das optionale Element AUSNachricht fehlt jedoch) gesendet werden. Der Datenkonsument darf in diesem Fall keine Rückschlüsse auf irgendwelche Linienfahrpläne ziehen, weil die Antwort darüber nichts aussagt.
	[REF_AUS, 'Linienfahrplan'], // Linienfahrplan is a child of AUSNachricht
	[AUS, 'AUSNachricht'],
])

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// > When delay is larger than 2147483647 or less than 1, the delay will be set to 1. Non-integer delays are truncated to an integer.
// https://nodejs.org/docs/latest-v20.x/api/timers.html#settimeoutcallback-delay-args
const SETTIMEOUT_MAX_DELAY = 2147483647

const DFI_DEFAULT_SUBSCRIPTION_TTL = 1 * HOUR
const REF_AUS_DEFAULT_SUBSCRIPTION_TTL = 1 * DAY
const AUS_DEFAULT_SUBSCRIPTION_TTL = 1 * HOUR

const SUBSCRIPTION_EXPIRED_MSG = 'subscription expired'
const UNSUBSCRIBED_MANUALLY_MSG = 'unsubscribed manually'
const SUBSCRIPTION_CANCELED_BY_SERVER_MSG = 'subscription canceled by the server'

const STORAGE_TTL_STARTDIENSTZST = 3 * DAY
const STORAGE_KEY_STARTDIENSTZST = 'startdienstzst'

const STORAGE_TTL_SERVER_STATE = 3 * DAY
// $STORAGE_PREFIX_LATEST_SERVER_STARTDIENSTZST:$service -> latest known (parsed!) StartDienstZst
const STORAGE_PREFIX_LATEST_SERVER_STARTDIENSTZST = 'server-latest-startdienstzst:'
// $STORAGE_PREFIX_LATEST_SERVER_DATENVERSIONID:$service -> latest known DatenVersionID
const STORAGE_PREFIX_LATEST_SERVER_DATENVERSIONID = 'server-latest-datenversionid:'

// $STORAGE_PREFIX_SUBSCRIPTIONS:$service:$aboID -> expiresAt
const STORAGE_PREFIX_SUBSCRIPTIONS = 'subs:'

const waitFor = async (ms, abortSignal) => {
	await new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		const onAbort = () => {
			abortSignal.removeEventListener('abort', onAbort)
			clearTimeout(timer)
			resolve()
		}
		abortSignal.addEventListener('abort', onAbort)
	})
}

// This implementation follows the VDV 453 spec, as documented in the "VDV-453 Ist-Daten-Schnittstelle – Version 2.4" document. It also supports the VDV 454 extension, as documented in the "VDV-454 Ist-Daten-Schnittstelle – Fahrplanauskunft – Version 2.0".
// https://web.archive.org/web/20240221234602/https://www.vdv.de/453v24-sds.pdfx?forced=false
// https://web.archive.org/web/20240222010651/https://www.vdv.de/454v2.0-sd.pdfx?forced=false
// https://web.archive.org/web/20231205141847/https://www.vdv.de/vdv453-incl-454-v2015.a-ohne-siri-20150630.zipx?forced=true
// see also https://web.archive.org/web/20231208122259/https://www.vdv.de/i-d-s-downloads.aspx

const createClient = async (cfg, opt = {}) => {
	const {
		leitstelle,
		theirLeitstelle,
	} = cfg
	strictEqual(typeof leitstelle, 'string', 'cfg.leitstelle must be a string')
	ok(leitstelle, 'cfg.leitstelle must not be empty')
	strictEqual(typeof theirLeitstelle, 'string', 'cfg.theirLeitstelle must be a string')
	ok(theirLeitstelle, 'cfg.theirLeitstelle must not be empty')

	const {
		logger,
		requestsLogger,
		fetchSubscriptionsDataPeriodically,
		openStorage,
		onDatenBereitAnfrage,
		onClientStatusAnfrage,
		onStatusAntwort,
		onServerXSDVersionID,
		onSubscriptionCreated,
		onSubscriptionRestored,
		onSubscriptionExpired,
		onSubscriptionCanceled,
		onSubscriptionsResetByServer,
		onSubscriptionManualFetchStarted,
		onSubscriptionManualFetchSucceeded,
		onSubscriptionManualFetchFailed,
		onDatenAbrufenAntwort,
		onDataFetchStarted,
		onDataFetchSucceeded,
		onDataFetchFailed,
		onRefAusFetchStarted,
		onRefAusFetchSucceeded,
		onRefAusFetchFailed,
		onAusFetchStarted,
		onAusFetchSucceeded,
		onAusFetchFailed,
	} = {
		logger: pino({
			level: process.env.LOG_LEVEL || 'info',
		}),
		// separate logger for network requests, they are too noisy usually
		requestsLogger: pino({
			level: process.env.LOG_LEVEL_REQUESTS || 'info',
			// todo: remove some fields from logs, e.g.
			// - clientRequest.agent
			// - clientRequest.res
			// - serverResponse._readableState
			// - serverResponse.client
			// - serverResponse.req
		}),
		// Some VDV-453 systems may not notify us about new/changed data (see _handleDatenBereitAnfrage), so we fetch the data "manually" periodically.
		// todo [breaking]: default to false
		fetchSubscriptionsDataPeriodically: true,
		openStorage: openInMemoryStorage,
		// hooks for debugging/metrics/etc.
		onDatenBereitAnfrage: (svc, datenBereitAnfrage) => {},
		onClientStatusAnfrage: (svc, clientStatusAnfrage) => {},
		onStatusAntwort: (svc, statusAntwort) => {},
		onServerXSDVersionID: (svc, xsdVersionID) => {},
		onSubscriptionCreated: (svc, {aboId, expiresAt, aboSubTag, aboSubChildren}, bestaetigung, subStats) => {},
		onSubscriptionRestored: (svc, {aboId, expiresAt}) => {},
		onSubscriptionExpired: (svc, {aboId, aboSubTag, aboSubChildren}, subStats) => {},
		onSubscriptionCanceled: (svc, {aboId, aboSubTag, aboSubChildren}, reason, subStats) => {},
		onSubscriptionsResetByServer: (svc, subStats) => {},
		onSubscriptionManualFetchStarted: (svc, {aboId, aboSubTag, aboSubChildren}) => {},
		onSubscriptionManualFetchSucceeded: (svc, {aboId, aboSubTag, aboSubChildren}, {timePassed}) => {},
		onSubscriptionManualFetchFailed: (svc, {aboId, aboSubTag, aboSubChildren}) => {},
		onDatenAbrufenAntwort: (svc, {datensatzAlle, weitereDaten, itLevel, bestaetigung}) => {},
		onDataFetchStarted: (svc, {datensatzAlle}) => {},
		onDataFetchSucceeded: (svc, {datensatzAlle}, {nrOfFetches, timePassed}) => {},
		onDataFetchFailed: (svc, {datensatzAlle}, err, {nrOfFetches, timePassed}) => {},
		onRefAusFetchStarted: ({datensatzAlle}) => {},
		onRefAusFetchSucceeded: ({datensatzAlle}, {nrOfSollFahrts}) => {},
		onRefAusFetchFailed: ({datensatzAlle}, err, {nrOfSollFahrts}) => {},
		onAusFetchStarted: ({datensatzAlle}) => {},
		onAusFetchSucceeded: ({datensatzAlle}, {nrOfIstFahrts}) => {},
		onAusFetchFailed: ({datensatzAlle}, err, {nrOfIstFahrts}) => {},
		...opt,
	}
	ok('object' === typeof logger && logger, 'opt.logger must be an object')
	cfg = {
		...cfg,
		logger,
	}

	// When fetching all new data from the server, the maximum number of fetch iterations. The number of items per iterations depends on the server.
	const datenAbrufenMaxIterations = {
		default: 10,
		[AUS]: 300,
		[REF_AUS]: 1000,
		...(opt.datenAbrufenMaxIterations ?? {}),
	}

	const {
		remoteEndpointId,
		sendRequest,
	} = createSendRequest({
		...cfg,
		logger: requestsLogger,
	}, opt)
	const {router, errorHandler} = createServer({
		...cfg,
		logger: requestsLogger,
	}, opt)

	// todo: serve basic information about the service on /

	const data = new EventEmitter()

	// ----------------------------------

	// todo: move to lib/server.js?
	const _onRequest = (service, call, handleRequest) => {
		const path = '/' + [
			theirLeitstelle,
			service,
			call,
		].map(part => encodeURIComponent(part)).join('/')
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

			res.respondWithResponse({
				ok: true, // todo: are we ever not okay?
				status: true, // send Status element
				children: [
					x('StartDienstZst', {}, startDienstZst),
					// todo: provide AktiveAbos if `clientStatusAnfrage.$.MitAbos` has value `true`
					// > 5.1.8.3 ClientStatusAnfrage
					// > Beispiel 3: Antwort des Clients: Dienst verfügbar, Client initialisiert gerade und will keine Auskunft zu den aktiven Abonnements geben:
					// > 5.1.8.3 ClientStatusAnfrage
					// > […]
					// > Stellt der Server einen Unterschied zwischen seiner Abonnementliste und der Liste vom Client, kann der Server entweder stillschweigend den Unterschied beseitigen indem er die nicht aus der Clientsicht aktiven Abonnements löscht und die aus der Clientsicht aktiven Abonnements registriert und anfängt für diese Daten bereitzustellen oder er setzt den StartDienstZst in seiner StatusAntwort auf die aktuelle Zeit und erzwingt somit die Neuinitiali- sierung des Clients. Der zweite Weg wird empfohlen.
					// > Ist die Struktur AktiveAbos leer, hat der Client keine aktiven Abonnements. Falls der Server doch welche kennt, sollen diese stillschweigend deaktiviert werden.
				],
			})

			await onClientStatusAnfrage(service, clientStatusAnfrage)

			try {
				await _checkClientStatusAnfrage(service, clientStatusAnfrage)
			} catch (err) {
				logger.warn({
					...logCtx,
					err,
				}, `failed to check ClientStatusAnfrage: ${err.message}`)
			}
		})
	}

	const _sendStatusAnfrage = async (service) => {
		const logCtx = {
			service,
		}

		const {
			clientRequest: req,
			serverResponse: res,
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
		for await (const el of tags) {
			const tag = el.$name
			if (tag === 'StatusAntwort') {
				assertStatusAntwortOk(el, logCtx)
				const datenBereit = el.DatenBereit?.$text?.trim() === 'true'
				const startDienstZst = el.StartDienstZst?.$text || null
				const datenVersionID = el.DatenVersionID?.$text || null
				logger.debug({
					...logCtx,
					datenBereit,
					startDienstZst,
					datenVersionID,
				}, 'received StatusAntwort')

				await onStatusAntwort(service, el)

				try {
					await _checkServerStatusAntwort(service, el)
				} catch (err) {
					logger.warn({
						...logCtx,
						err,
					}, `failed to check server StatusAntwort: ${err.message}`)
				}

				return {
					datenBereit,
					startDienstZst,
					datenVersionID,
					statusAntwort: el,
				}
			}
			// todo: otherwise warn-log unexpected tag?
		}
		throw new Vdv453ApiError(
			service,
			'StatusAnfrage',
			`server's reponse body does not contain a StatusAntwort`,
			'?',
			req,
			null, // reqOpts
			null, // reqBody
			res,
		)
	}

	// > 5.1.7 Wiederaufsetzen nach Absturz
	// > […]
	// > Verliert der Server seine Abonnement-Daten, so ist dies zunächst vom Client aus nicht feststellbar. DatenBereitAnfragen bleiben zwar aus, aber dies kann nicht vom normalen Betrieb unterschieden und somit der Absturz des Servers nicht festgestellt werden. Um diesen Fall zu erkennen, sind zusätzliche, zyklische Anfragen vom Typ StatusAnfrage (5.1.8.1) zum Server zu senden. Innerhalb der StatusAntwort (5.1.8.2) gibt der Server den Zeitstempel des Dienststarts an. Fand der Dienststart nach der Einrichtung der Abonnements statt, so muss vom Verlust der Abonnements ausgegangen werden. Es ist nun zu verfahren wie beim Client-Datenverlust: Löschen und Neueinrichtung aller Abonnements.
	// > […]
	// > 5.1.8 Alive-Handling
	// > […]
	// > 5.1.8.2 Antwort (StatusAntwort, Status)
	// > Sobald der Server in einer StatusAntwort einen aktualisierten Wert von StartDienstZst und DatenVersionID mitteilt (oder DatenVersionID vom System noch nicht unterstützt wird), muss der Client davon ausgehen, dass der Server-Dienst neu gestartet wurde und die Datenversorgung inkl. der Abonnements verloren gegangen ist.
	// > Wenn der Server eine neue Datenversion signalisieren will, muss er dies dem Client durch eine gleichzeitige Aktualisierung von StartDienstZst und DatenVersionID mitteilen.
	// > Sobald der Server in einer StatusAntwort einen aktualisierten Wert des StartDienstZst mitteilt, die DatenVersionID jedoch unverändert bleibt, kann der Client davon ausgehen, dass der Server-Dienst neu gestartet wurde, die bestehende Datenversorgung inkl. der Abonnement aber weiterhin vorliegt. Der Client muss die auf diesen Dienst bezogenen Daten und Abonnements daher *nicht* löschen. Eine Erneuerung der Abonnements und neu Abrufen der Daten ist in dem Fall nicht notwendig.
	const _checkStartDienstZstAndDatenVersionID = async (service, startDienstZst, datenVersionID) => {
		const tStartDienstZst = Date.parse(startDienstZst)
		ok(Number.isInteger(tStartDienstZst), 'StartDienstZst not parsable as ISO 8601')

		const logCtx = {
			service,
			tStartDienstZst,
			datenVersionID,
		}

		// todo: once we persist the latest known StartDienstZst/DatenVersionID, call onSubscriptionsResetByServer() even in these cases!
		if (!await storage.has(STORAGE_PREFIX_LATEST_SERVER_STARTDIENSTZST + service)) {
			logger.trace({
				...logCtx,
				tStartDienstZst,
			}, 'previously unknown server StartDienstZst')
			await storage.set(
				STORAGE_PREFIX_LATEST_SERVER_STARTDIENSTZST + service,
				String(tStartDienstZst),
				STORAGE_TTL_SERVER_STATE,
			)
			return;
		}
		if (!await storage.has(STORAGE_PREFIX_LATEST_SERVER_DATENVERSIONID + service)) {
			logger.trace({
				...logCtx,
				tStartDienstZst,
			}, 'previously unknown server DatenVersionID')
			await storage.set(
				STORAGE_PREFIX_LATEST_SERVER_DATENVERSIONID + service,
				datenVersionID,
				STORAGE_TTL_SERVER_STATE,
			)
			return;
		}

		const prevTStartDienstZst = parseInt(await storage.get(STORAGE_PREFIX_LATEST_SERVER_STARTDIENSTZST + service))
		const prevDatenVersionID = await storage.get(STORAGE_PREFIX_LATEST_SERVER_DATENVERSIONID + service)
		if (tStartDienstZst !== prevTStartDienstZst) {
			logger.trace({
				...logCtx,
				prevTStartDienstZst,
			}, 'server StartDienstZst has changed')
		}
		if (datenVersionID !== prevDatenVersionID) {
			logger.trace({
				...logCtx,
				prevDatenVersionID,
			}, 'server DatenVersionID has changed')
		}

		const subscriptionsReset = tStartDienstZst !== prevTStartDienstZst && datenVersionID !== prevDatenVersionID
		await storage.set(
			STORAGE_PREFIX_LATEST_SERVER_STARTDIENSTZST + service,
			String(tStartDienstZst),
			STORAGE_TTL_SERVER_STATE,
		)
		await storage.set(
			STORAGE_PREFIX_LATEST_SERVER_DATENVERSIONID + service,
			datenVersionID,
			STORAGE_TTL_SERVER_STATE,
		)

		if (subscriptionsReset) {
			logger.info({
				...logCtx,
				prevTStartDienstZst,
				prevDatenVersionID,
			}, 'server StartDienstZst and DatenVersionID have changed')

			for await (const {aboId} of _readSubscriptions(service)) {
				await _abortSubscription(service, aboId, SUBSCRIPTION_CANCELED_BY_SERVER_MSG)
			}

			await onSubscriptionsResetByServer(service, await _getSubStats(service))

			// todo: silently recreate all subscriptions? or leave this to the caller?
		}
	}
	const _checkServerStatusAntwort = async (service, statusAntwort) => {
		const startDienstZst = statusAntwort.StartDienstZst?.$text || null
		ok(startDienstZst !== null, 'missing StatusAntwort.StartDienstZst')
		const datenVersionID = statusAntwort.DatenVersionID?.$text || null
		ok(datenVersionID !== null, 'missing StatusAntwort.DatenVersionID')

		await _checkStartDienstZstAndDatenVersionID(service, startDienstZst, datenVersionID)
	}
	const _checkClientStatusAnfrage = async (service, clientStatusAfrage) => {
		const startDienstZst = clientStatusAfrage.StartDienstZst?.$text || null
		ok(startDienstZst !== null, 'missing ClientStatusAnfrage.StartDienstZst')
		const datenVersionID = clientStatusAfrage.DatenVersionID?.$text || null
		ok(datenVersionID !== null, 'missing ClientStatusAnfrage.DatenVersionID')

		await _checkStartDienstZstAndDatenVersionID(service, startDienstZst, datenVersionID)
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

		let result = null

		const tags = parseResponse([
			{tag: 'AboAntwort', preserve: true}, // todo: remove
			{tag: BESTAETIGUNG, preserve: true},
			// todo: support `BestaetigungMitAboID` for >1 subscriptions in one call? – see also "5.1.2.2.1 Vorgehen für mehrfache BestaetigungMitAboID einer AboAnfrage"
			// > 5.1.2.2 Abonnementsbestätigung (AboAntwort)
			// > […]
			// > (Unterelement, alternativ, mehrfach) Enthält für jedes Abonement (AboID) separate Informationen zur Fehlerbehandlung.
			// > […]
			// > Seit den Standard-Versionen VDV453 v2.4 und VDV454 v2.0 kann eine AboAnfrage mit mehreren Abonnements durch einer AboAntwort mit mehrfachen dedizierten AboBestaetigungMitAboID sowie Fehlermeldungen für jedes Abonnement (AboID) beantwortet werden.
		])
		for await (const el of tags) {
			const tag = el.$name

			// > 5.1.2.2 Abonnementsbestätigung (AboAntwort)
			// > […]
			// > Mit dem optionalen Element XSDVersionID in AboAnfrage und AboAntwort tauschen Client und Server die Versionskennung der Schnittstelle aus, die jeder von ihnen verwendet. Damit können beide Seiten Kompatibilitätsprüfungen vornehmen. Die aktuelle Version ist im XML-Schema im Attribut Version angegeben (Dateiname des XSD-Files, z.B. `xsd_2015a`).
			if (tag === 'AboAntwort') {
				const xsdVersionID = el.$.XSDVersionID ?? null
				if (xsdVersionID !== null) {
					await onServerXSDVersionID(service, xsdVersionID)
				}
				continue
			}

			if (tag === BESTAETIGUNG) {
				assertBestaetigungOk(el)
				// todo: warn if DatenGueltigBis < aboParams.VerfallZst?
				// > (optional) Ende des Datenhorizontes des Datenproduzenten. Entfällt, wenn Anfrage vollständig im Datenhorizont liegt.
				// todo: add hook onAboAntwort()?
				result = el
				continue
			}
			// todo: otherwise warn-log unexpected tag?
		}

		return result
	}

	const _nrOfSubscriptions = async (service) => {
		let _nr = 0
		// todo: add `storage` method for more efficient calculation?
		for await (const _ of _readSubscriptions(service)) {
			_nr++
		}
		return _nr
	}
	const _getSubStats = async (service) => ({
		nrOfSubscriptions: await _nrOfSubscriptions(service),
	})

	const _abortSubscription = async (service, aboId, reason) => {
		const subscriptionAbortController = subscriptionAbortControllers[service].get(aboId)
		ok(subscriptionAbortController, `invalid abo ID "${aboId}" for service ${service}`)

		// Note: We delete from `subscriptions` before abort()-ing.
		await storage.del(STORAGE_PREFIX_SUBSCRIPTIONS + service + ':' + aboId)
		subscriptionAbortControllers[service].delete(aboId)
		subscriptionAbortController.abort(reason)
	}

	const _readSubscriptions = async function* (service = null, readExpiresAt = false) {
		const prefix = STORAGE_PREFIX_SUBSCRIPTIONS + (service === null ? '' : service + ':')
		const entries = await storage[readExpiresAt ? 'entries' : 'keys'](prefix)
		for (const entry of entries) {
			const key = readExpiresAt ? entry[0] : entry
			const val = readExpiresAt ? entry[1] : null

			const [_, service, aboId] = key.split(':')
			const expiresAt = readExpiresAt ? parseInt(val) : null
			yield {service, aboId, expiresAt}
		}
	}

	const getAllSubscriptions = async () => {
		const _subscriptions = Object.create(null)
		for await (const {service, aboId, expiresAt} of _readSubscriptions(null, true)) {
			if (!(service in _subscriptions)) {
				_subscriptions[service] = new Map()
			}
			_subscriptions[service].set(aboId, expiresAt)
		}
		return _subscriptions
	}

	const _ensureSubscriptionWillExpire = async (service, aboId, expiresIn) => {
		const logCtx = {
			service,
			aboId,
		}
		ok(expiresIn <= SETTIMEOUT_MAX_DELAY, 'expiresIn is too large')

		const subscriptionAbortController = new AbortController()
		subscriptionAbortControllers[service].set(aboId, subscriptionAbortController)

		// on abort, call hooks
		const markSubscriptionAsExpiredOrCanceled = async () => {
			const subStats = await _getSubStats(service)
			if (subscriptionAbortController.signal.reason === SUBSCRIPTION_EXPIRED_MSG) {
				try {
					await onSubscriptionExpired(service, logCtx, subStats)
				} catch (err) {
					logger.warn({
						...logCtx,
						subStats,
					}, 'onSubscriptionExpired() hook failed')
					if (isProgrammerError(err)) {
						throw err
					}
				}
			} else {
				try {
					await onSubscriptionCanceled(service, logCtx, subscriptionAbortController.signal.reason, subStats)
				} catch (err) {
					logger.warn({
						...logCtx,
						abortReason: subscriptionAbortController.signal.reason,
						subStats,
					}, 'onSubscriptionCanceled() hook failed')
					if (isProgrammerError(err)) {
						throw err
					}
				}
			}
		}
		subscriptionAbortController.signal.addEventListener('abort', () => {
			markSubscriptionAsExpiredOrCanceled()
			.catch((err) => {
				logger.error({
					...logCtx,
					err,
				}, `failed to mark subscription as expired or canceled: ${err.message}`)
			})
		})

		// expiration timer fires -> abort subscription
		// subscription aborted externally -> clear expiration timer
		{
			const expireSubClientSide = () => {
				logger.trace(logCtx, 'expiring subscription client-side')
				_abortSubscription(service, aboId, SUBSCRIPTION_EXPIRED_MSG)
				.catch((err) => {
					logger.warn({
						...logCtx,
						err,
					}, `failed to expire subscription client-side: ${err.message}`)
				})
			}

			const expirationTimer = setTimeout(expireSubClientSide, expiresIn)
			expirationTimer.unref() // todo: is this correct?
			_expirationTimersBySubAbortController.set(subscriptionAbortController, expirationTimer)

			// clear expiration timer on external subscription abort
			// If the subscription got aborted externally (i.e. not because it has expired but for some other reason), we should clear the timeout.
			// todo: Also, we clear the subscription abort listener as soon as the expiration timer fires.
			{
				const cancelExpirationTimer = () => {
					logger.trace(logCtx, `subscription aborted client-side: "${subscriptionAbortController.signal.reason}"`)

					// de-listen self, a.k.a. once()
					subscriptionAbortController.signal.removeEventListener('abort', cancelExpirationTimer)

					const expirationTimer = _expirationTimersBySubAbortController.get(subscriptionAbortController)
					clearTimeout(expirationTimer)
				}
				subscriptionAbortController.signal.addEventListener('abort', cancelExpirationTimer)
			}
		}

		return {
			subscriptionAbortController,
		}
	}

	// subscriptionAbortController -> timer
	const _expirationTimersBySubAbortController = new WeakMap()
	const _subscribe = async (service, aboSubChildren, expiresAt, fetchNewDataUntilNoMoreAvailable, fetchInterval) => {
		// todo: validate arguments
		ok(
			ABO_ANFRAGE_ROOT_SUB_TAGS_BY_SERVICE.has(service),
			`invalid/unknown tag of root sub element for service "${service}"`
		)
		const aboSubTag = ABO_ANFRAGE_ROOT_SUB_TAGS_BY_SERVICE.get(service)
		// todo: handle BigInt?
		ok(Number.isInteger(expiresAt), 'expiresAt must be a UNIX timestamp')
		// todo: what if the server has a different date/time configured?
		const expiresIn = expiresAt - Date.now()
		ok(expiresIn > 0, 'expiresAt must be in the future')
		// todo: consider using e.g. https://github.com/trs/set-long-timeout/issues/2#issue-1912020818 here?
		ok(expiresIn <= SETTIMEOUT_MAX_DELAY, `expiresAt must not be greater than ${SETTIMEOUT_MAX_DELAY}`)

		const aboId = getNextAboId()
		const logCtx = {
			service,
			aboId,
			expiresAt,
			fetchInterval,
		}
		logger.debug({
			...logCtx,
			aboSubTag,
			aboSubChildren,
		}, 'subscribing to items')

		const aboParams = [
			x(aboSubTag, {
				AboID: aboId,
				VerfallZst: getZst(expiresAt),
				// todo: support attributes!
			}, aboSubChildren)
		]

		// keep track of the subscription using the `aboID`
		// We do this before sending the request because we might crash while the request is in-flight.
		await storage.set(STORAGE_PREFIX_SUBSCRIPTIONS + service + ':' + aboId, String(expiresAt), expiresIn)

		let bestaetigung
		try {
			bestaetigung = await _sendAboAnfrage(
				service,
				aboParams,
			)
		} catch (err) {
			await storage.del(STORAGE_PREFIX_SUBSCRIPTIONS + service + ':' + aboId)
			throw err
		}

		const {
			subscriptionAbortController,
		} = await _ensureSubscriptionWillExpire(service, aboId, expiresIn)

		await onSubscriptionCreated(
			service,
			{
				aboId,
				expiresAt,
				aboSubTag,
				aboSubChildren,
			},
			bestaetigung,
			await _getSubStats(service),
		)

		if (fetchSubscriptionsDataPeriodically) {
			ok(Number.isInteger(fetchInterval), 'fetchInterval must be an integer')

			const fetchPeriodicallyAndLogErrors = async () => {
				// Usually subscriptions get created on client startup, so wait a bit for the server to notify us about new data (DatenBereitAnfrage) *if it supports that*. Only when it hasn't done that (quickly enough), we fetch manually.
				const fetchIntervalInitialWait = Math.max(fetchInterval / 30, 2_000) // 2 seconds minimum
				await new Promise(resolve => setTimeout(resolve, fetchIntervalInitialWait))

				while (!subscriptionAbortController.signal.aborted) {
					logger.debug(logCtx, 'manually fetching data')
					await onSubscriptionManualFetchStarted(service, logCtx)

					// `subscriptionAbortController` controls the periodic fetching, `fetchAbortController` controls an individual fetch. The former aborts the latter, but not vice versa.
					const fetchAbortController = new AbortController()
					const cancelFetch = () => {
						fetchAbortController.abort(subscriptionAbortController.signal.reason)
					}
					subscriptionAbortController.signal.addEventListener('abort', cancelFetch)

					try {
						const t0 = performance.now()
						// Note: The server might also notify us of new data, to which we react with fetching new data (see _handleDatenBereitAnfrage()), so just doing it "manually" here nonetheless would result in fetching the twice in parallel. Therefore we use _fetch*NewDataUntilNoMoreAvailable() with maxIterations=1 instead of _fetchNew*DataOnce(), because the former will only ever run once in parallel.
						// todo [breaking]: Infinity maxIterations (and remove parameter) – this breaks the assumption how often a manual fetch will be done: "every fetchInterval + timePassed(fetchOnce)" -> "whenever fetchInterval has passed without DatenBereitAbfrage"
						const maxIterations = 1
						await fetchNewDataUntilNoMoreAvailable(maxIterations)
						const timePassed = performance.now() - t0

						await onSubscriptionManualFetchSucceeded(service, logCtx, {
							timePassed,
						})
						logger.debug({
							...logCtx,
							timePassed,
						}, 'successfully fetched data manually')
					} catch (err) {
						// todo: error-log programmer errors!
						logger.warn({
							...logCtx,
							err,
						}, `failed to fetch & process data: ${err.message}`)
						await onSubscriptionManualFetchFailed(service, logCtx, err)
					} finally {
						subscriptionAbortController.signal.removeEventListener('abort', cancelFetch)
					}

					// todo: make configurable based on previous fetch's success & duration
					await waitFor(fetchInterval, subscriptionAbortController.signal)
				}
			}

			fetchPeriodicallyAndLogErrors()
			.catch((err) => {
				logger.error({
					service,
					err,
				}, `failed to fetch data periodically: ${err.message}`)
			})
		}

		// todo: move this up, above the fetchPeriodicallyAndLogErrors() loop
		logger.trace({
			...logCtx,
			bestaetigung,
		}, 'successfully subscribed')
		return {
			aboId,
			// todo: pass `subscriptionAbortController.signal` to allow client to witness expiration/cancelation?
		}
	}

	const _unsubscribe = async (service, aboIds, silenceSubscriptionNotFoundError = false) => {
		const logCtx = {
			service,
			aboIds,
		}
		logger.debug(logCtx, 'unsubscribing from subscriptions')

		try {
			const aboParams = aboIds.map(aboId => x('AboLoeschen', {}, aboId))
			const bestaetigung = await _sendAboAnfrage(
				service,
				aboParams,
			)
			logCtx.bestaetigung = bestaetigung
		} catch (err) {
			const match = /zu löschenden Abonnements (\d+(, \d+)?) wurden nicht gefunden/i.exec(err.message)
			if (match && match[1]) {
				err.isSubscriptionNotFoundError = true
				if (silenceSubscriptionNotFoundError) {
					logCtx.notFoundAboIds = match[1].split(', ')
					return;
				}
			}
			throw err
		}

		for (const aboId of aboIds) {
			const abortController = subscriptionAbortControllers[service].get(aboId)
			if (!abortController) {
				continue
			}
			await _abortSubscription(service, aboId, UNSUBSCRIBED_MANUALLY_MSG)
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

		for await (const {aboId} of _readSubscriptions(service)) {
			await _abortSubscription(service, aboId, UNSUBSCRIBED_MANUALLY_MSG)
		}
		logger.debug(logCtx, 'successfully unsubscribed from all subscriptions')
	}

	const unsubscribeAllOwned = async () => {
		const _subscriptions = Object.create(null)
		for await (const {service, aboId} of _readSubscriptions()) {
			if (!(service in _subscriptions)) {
				_subscriptions[service] = [aboId]
			} else {
				_subscriptions[service].push(aboId)
			}
		}

		await Promise.all(Object.entries(_subscriptions).map(async ([service, aboIds]) => {
			await _unsubscribe(service, aboIds, true)
		}))
	}

	// ----------------------------------

	// service -> true/false
	const isFetchingData = {}
	// service -> true/false
	// - set to true by _processDatenBereitAnfrage() at any point in time
	// - set to false by _fetchNewDataUntilNoMoreAvailable() before fetching
	const datenBereitAnfrageReceivedWhileFetching = {}

	// The server should notify the client of new/changed data, so that the latter can then request it.
	// > 5.1.3.1 Datenbereitstellung signalisieren (DatenBereitAnfrage)
	// > Ist das Abonnement eingerichtet und sind die Daten bereitgestellt, wird der Datenkonsument durch eine DatenBereitAnfrage über das Vorhandensein aktualisierter Daten informiert. Dies geschieht bei jeder Änderung der Daten die dem Abonnement zugeordnet sind. Die Signalisierung bezieht sich auf alle Abonnements eines Dienstes.
	// The VDV API is constantly notifying us via `DatenBereitAnfrage`s when any IstFahrt(s) has changed, even while we're currently fetching. Because of the latency between us and the API, it's essentially a distributed system of two parties that try to sync their state: We do't know if the newly changed IstFahrt is already included in the batch currently being fetched.
	// This is why we just fetch again afterwards whenever we have received a DatenBereitAnfrage while fetching.
	const _fetchNewDataUntilNoMoreAvailable = async (service, fetchNewDataOnce, maxIterations) => {
		ok(maxIterations === Infinity || Number.isInteger(maxIterations))
		const logCtx = {
			service,
			maxIterations: String(maxIterations), // pino cannot serialize Infinity :/
		}

		if ((await _nrOfSubscriptions(service)) === 0) { // 0 subscriptions on `service`
			logger.trace(logCtx, `not starting to fetch new ${service} data again, because there are no subscriptions (anymore)`)
			return;
		}
		// Make sure there's only ever one of this function running.
		if (isFetchingData[service]) {
			logger.trace(logCtx, `not starting to fetch new ${service} data again, because we're already fetching`)
			return;
		}
		logger.debug(logCtx, `starting to fetch new ${service} data until no new data is available anymore`)

		isFetchingData[service] = true
		let iterations = 0
		try {
			while (++iterations <= maxIterations || datenBereitAnfrageReceivedWhileFetching[service]) {
				datenBereitAnfrageReceivedWhileFetching[service] = false
				// We must keep looping even with fetch failures, so we catch & log all errors.
				try {
					await fetchNewDataOnce({
						// todo: allow this to get cancelled from the outside
						abortController: new AbortController(),
					})
				} catch (err) {
					// todo: throw ES errors: ReferenceError, TypeError, etc.
					logger.warn({
						...logCtx,
						iteration: iterations - 1,
						err,
					}, `failed to fetch new ${service} data: ${err.message}`)
					// todo: `datenBereitAnfrageReceivedWhileFetching[service] = true` to cause a refetch? – prevent endless cycles! exponential backoff?
				}
				// todo: wait for a moment before refetching?
			}
		} finally {
			isFetchingData[service] = false
		}
	}

	// todo: move into the subs section?
	const _handleDatenBereitAnfrage = (service, fetchNewDataUntilNoMoreAvailable) => {
		const _processDatenBereitAnfrage = async (req, res) => {
			const logCtx = {
				service,
			}

			if ((await _nrOfSubscriptions(service)) === 0) { // 0 subscriptions on `service`
				logger.warn(logCtx, 'received DatenBereitAnfrage, even though we don\'t know about a subscription')
				res.respondWithResponse({
					ok: false,
					bestaetigung: true, // send Bestaetigung element
				})
				return;
			}

			const datenBereitAnfrage = await req.parseWholeRoot('DatenBereitAnfrage')
			logCtx.datenBereitAnfrage = datenBereitAnfrage
			logger.debug(logCtx, 'received DatenBereitAnfrage')

			res.respondWithResponse({
				ok: true,
				bestaetigung: true, // send Bestaetigung element
			})

			await onDatenBereitAnfrage(service, datenBereitAnfrage)

			datenBereitAnfrageReceivedWhileFetching[service] = true

			const maxIterations = Infinity // todo: why?
			fetchNewDataUntilNoMoreAvailable(maxIterations)
			.catch((err) => {
				// Because it catches fetch errors by itself, if it does reject, we likely have a bug.
				logger.error({
					...logCtx,
					err,
				}, `failed to continuously fetch new ${service} data: ${err.message}`)
				// todo: does this case warrant crashing?
				process.exit(1)
			})
		}
		_onRequest(service, DATEN_BEREIT, _processDatenBereitAnfrage)
	}

	// todo:
	// > 5.1.4.1 Datenübertragung anfordern (DatenAbrufenAnfrage)
	// > Wurde bereits eine DatenAbrufenAnfrage vom Client an den Server versandt, so ist für diese vom Client eine DatenAbrufenAntwort abzuwarten (Antwort, oder Timeout), bevor erneut eine DatenAbrufenAnfrage versandt wird. Es wird daher empfohlen keine weitere DatenAbrufenAnfrage zu stellen, solange noch eine DatenAbrufenAnfrage aktiv ist.
	const WEITERE_DATEN = 'WeitereDaten'

	// We need to fetch data in >1 pages. For better consumer ergonomics, we expose it as *one* async iterable. We also want to process each response's body iteratively. Effectively, by using async iteration, we signal "backpressure" to the response parsing code.
	// However, `yield*` (and the non-async-iterable `await`) with recursive function calls prevents Node.js from garbage-collecting allocations of the caller. [0]
	// This is why we use a trampoline [1] here. Because we use `yield*`, we cannot use the (inner function's) return value to signal if iteration/recursion should continue, so we use an object instead.
	// [0] https://medium.com/@RomarioDiaz25/the-problem-with-infinite-recursive-promise-resolution-chains-af5b97712661
	// [1] https://stackoverflow.com/a/489860/1072129
	const _fetchDataOnce = async function* (service, opt) {
		await onDataFetchStarted(service, opt)

		const maxIterations = datenAbrufenMaxIterations[service] ?? datenAbrufenMaxIterations.default
		ok(Number.isInteger(maxIterations), `opt.datenAbrufenMaxIterations[${service}] or opt.datenAbrufenMaxIterations.default must be an integer`)

		let timePassed = null
		let itLevel = 0
		try {
			const t0 = performance.now()
			const itControl = {
				maxIterations,
				continue: false,
			}
			while (true) {
				itControl.continue = false
				yield* _sendDatenAbrufenAnfrage(service, opt, itLevel++, itControl)
				if (itControl.continue !== true) break
			}
			timePassed = performance.now() - t0
		} catch (err) {
			await onDataFetchFailed(service, opt, err, {
				nrOfFetches: itLevel,
				timePassed,
			})
			throw err
		}
		await onDataFetchSucceeded(service, opt, {
			nrOfFetches: itLevel,
			timePassed,
		})
	}
	const _sendDatenAbrufenAnfrage = async function* (service, opt, itLevel, itControl) {
		opt = {
			datensatzAlle: false,
			abortController: new AbortController(),
			...opt,
		}
		const {
			datensatzAlle,
			abortController,
		} = opt
		if (itLevel >= itControl.maxIterations) {
			// todo: throw more specific error?
			// todo [breaking]: "recursions" -> "iterations"
			const err = new Error(`${service}: too many recursions while fetching data`)
			err.service = service
			err.datensatzAlle = datensatzAlle
			// todo [breaking]: rename to `iterations`
			err.recursions = itLevel
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
			datensatzAlle,
			bestaetigung: null, // still unknown
			weitereDaten: null, // still unknown
			itLevel,
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
			{abortController},
		)

		const tags = parseResponse([
			{tag: BESTAETIGUNG, preserve: true},
			{tag: WEITERE_DATEN, preserve: true},
			{tag: dataSubTag, preserve: true},
		])
		let weitereDaten = false
		const ctx = {
			zst: null,
		}
		let onDatenAbrufenAntwortCalled = false
		for await (const el of tags) {
			if (abortController.signal.aborted) {
				logger.debug({
					...logCtx,
					reason: abortController.signal.reason,
				}, 'fetching aborted')
				return;
			}

			const tag = el.$name
			if (tag === BESTAETIGUNG) {
				assertBestaetigungOk(el)
				logCtx.bestaetigung = el
				ctx.zst = el.$.Zst ?? null

				continue
			}
			if (tag === WEITERE_DATEN) {
				if (el.$text !== 'true') continue;
				// > 5.1.4.2 Daten übertragen (DatenAbrufenAntwort)
				// > Der Server antwortet mit den aktualisierten Datensätzen innerhalb einer Nachricht vom Typ `DatenAbrufenAntwort`. Der Inhalt ist dienstspezifisch.
				// > Mittels des Elementes `WeitereDaten` wird angezeigt, ob der Inhalt von `DatenAbrufenAntwort` alle aktualisierten Daten enthält, oder ob aus technischen Gründen die Übermittlung in mehrere Pakete aufgeteilt wurde. Diese Daten können durch den Datenkonsumenten durch weitere `DatenAbrufenAnfrage`n beim Produzenten abholt werden. Beim letzten Datenpaket ist das Element `WeitereDaten` auf `false` gesetzt. Abweichend vom Standardverhalten optionaler Felder hat `WeitereDaten` den Default-Wert `false`. Ein fehlendes Element `WeitereDaten` zeigt also an, dass die Datenübertragung vollständig mit diesem Paket abgeschlossen wird.
				weitereDaten = logCtx.weitereDaten = true
			}
			if (tag === dataSubTag) {
				// We cannot guarantee the order of elements in the loop over `tags`, so `WEITERE_DATEN` might come *before* `BESTAETIGUNG`. Because we want both, and because we assume that actual data elements come up after the two, we call the hook here.
				if (!onDatenAbrufenAntwortCalled) {
					onDatenAbrufenAntwortCalled = true
					await onDatenAbrufenAntwort(service, logCtx)
				}

				yield [el, ctx]
				continue
			}
			// todo: otherwise warn-log unexpected tag?
		}

		if (weitereDaten) {
			logger.debug({
				...logCtx,
				bestaetigung: undefined,
			}, `received DatenAbrufenAntwort with WeitereDaten=true, iterating further (${itLevel + 1})`)
			itControl.continue = true
		}
	}

	// ----------------------------------

	const storage = await openStorage({
		remoteEndpointId,
	})

	let startDienstZst = getZst()
	{
		if (await storage.has(STORAGE_KEY_STARTDIENSTZST)) {
			startDienstZst = await storage.get(STORAGE_KEY_STARTDIENSTZST)
		} else {
			await storage.set(STORAGE_KEY_STARTDIENSTZST, startDienstZst, STORAGE_TTL_STARTDIENSTZST)
		}
	}

	// Technically, we don't need globally unique subscription IDs.
	// > 5.1.1 Überblick
	// > Eine AboID ist innerhalb eines jeden Dienstes eindeutig.
	const getNextAboId = () => String(10000 + Math.round(Math.random() * 9999))
	// todo: "Wird eine AboAnfrage mit einer AboID gestellt und es existiert bereits ein Abonnement unter dieser Bezeichnung, so wird das bestehende Abonnement überschrieben." – warn about this? does it apply across services?

	// todo: persist AboIDs across client restarts, reinstate fetch timers after restarts? – transactions (or locking as a fallback) will be necessary to guarantee consistent client behaviour (start transaction, set up subscription, upon success persist AboId, commit transaction)
	// todo: switch to this? service -> AboID -> {aboSubChildren, expiresAt, subscriptionAbortController}

	// service -> AboID -> subscriptionAbortController
	const subscriptionAbortControllers = Object.fromEntries(
		SERVICES.map(svc => [svc, new Map()]),
	)

	{
		for await (const {service, aboId, expiresAt} of _readSubscriptions(null, true)) {
			logger.debug({
				service,
				aboId,
				expiresAt,
			}, 're-activating persisted subscription')
			const expiresIn = expiresAt - Date.now()
			await _ensureSubscriptionWillExpire(service, aboId, expiresIn)

			await onSubscriptionRestored(service, {aboId, expiresAt})
		}
	}

	logger.info({
		startDienstZst,
		// pino doesn't seem to support `Map`s, so we convert them
		aboIdsByService: Object.fromEntries(
			Object.entries(subscriptionAbortControllers)
			.map(([svc, map]) => [svc, map.keys()]),
		),
	}, 'initial state')

	// > 5.1.8.2 Antwort (StatusAntwort, Status)
	// > […]
	// > Solange der Client keine StatusAntwort mit dem Status = „ok“ erhält, sollte dieser keine anderen Anfragen (z.B. AboAnfragen, DatenBereitAnfragen, DatenAbrufenAnfragen) an den Server schicken, um diesen im Fall eines Systemproblems nicht zusätzlich zu belasten und mit Anfragen zu überfluten
	// todo: implement this ^

	// todo: make configurable with a decent UX
	const datensatzAlle = false

	// ----------------------------------

	_handleClientStatusAnfrage(DFI)
	// _handleClientStatusAnfrage(REF_DFI)
	// _handleClientStatusAnfrage(ANS)
	// _handleClientStatusAnfrage(REF_ANS)
	// _handleClientStatusAnfrage(VIS)
	// _handleClientStatusAnfrage(AND)
	_handleClientStatusAnfrage(AUS)
	_handleClientStatusAnfrage(REF_AUS)

	// ----------------------------------

	const dfiSubscribe = async (azbId, opt = {}) => {
		const {
			expiresAt,
			linienId,
			richtungsId,
			vorschauzeit,
			hysterese,
			fetchInterval,
		} = {
			expiresAt: Date.now() + DFI_DEFAULT_SUBSCRIPTION_TTL,
			linienId: null,
			richtungsId: null,
			// todo: what does this do exactly? does it provide more data? – make it customizable
			// BVG's HACON system subscribes to AUS with `120`
			vorschauzeit: 10, // minutes
			// todo: is `0` possible? does it provide more data? – make it customizable
			// BVG's HACON system subscribes to AUS with `60`
			hysterese: 1, // seconds
			// todo [breaking]: rename to `manualFetchInterval`
			fetchInterval: 30_000, // 30s
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
		return await _subscribe(
			DFI,
			aboSubChildren,
			expiresAt,
			_fetchNewDfiDataUntilNoMoreAvailable,
			fetchInterval,
		)
	}
	const dfiUnsubscribe = async (...aboIds) => {
		return await _unsubscribe(DFI, aboIds)
	}
	const dfiUnsubscribeAll = async () => {
		return await _unsubscribeAll(DFI)
	}

	const _fetchNewDfiDataOnce = async (cfg) => {
		const {
			abortController,
		} = cfg

		const els = _fetchDataOnce(DFI, {
			datensatzAlle,
			abortController,
		})
		for await (const [azbNachricht] of els) {
			// todo: additionally emit azbNachricht.$children?
			data.emit(`raw:${DFI}:AZBNachricht`, azbNachricht)
		}
	}

	// user-triggered manual fetch
	const dfiFetchData = async (opt = {}) => {
		const {
			abortController,
		} = {
			abortController: new AbortController(),
			...opt,
		}
		await _fetchNewDfiDataOnce({
			abortController,
		})
	}

	// fetch triggered by the data provider, or by the subscription's manual fetch interval
	const _fetchNewDfiDataUntilNoMoreAvailable = async (maxIterations) => {
		await _fetchNewDataUntilNoMoreAvailable(DFI, _fetchNewDfiDataOnce, maxIterations)
	}
	_handleDatenBereitAnfrage(DFI, _fetchNewDfiDataUntilNoMoreAvailable)

	const dfiCheckServerStatus = async () => {
		return await _sendStatusAnfrage(DFI)
	}

	// ----------------------------------

	const refAusSubscribe = async (opt = {}) => {
		const now = Date.now()
		const {
			expiresAt,
			validFrom,

			fetchInterval,
		} = {
			expiresAt: now + REF_AUS_DEFAULT_SUBSCRIPTION_TTL,
			validFrom: now, // todo: default beginning of the day?

			// todo [breaking]: rename to `manualFetchInterval`
			fetchInterval: 300_000, // 5m
			...opt,
		}
		// todo: this is dangerous, what if i set validFrom to 3 months in the past? – implement a better default?
		const validUntil = 'validUntil' in opt
			? opt.validUntil
			: Math.max(validFrom, now) + REF_AUS_DEFAULT_SUBSCRIPTION_TTL
		// todo: validate arguments

		const aboSubChildren = [
			// > 5.1.1.1 Beschränkung der Daten nach Zeitbereich (Zeitfenster)
			// > Die Zeitpunkte in der Struktur Zeitfenster beziehen sich jeweils auf die Abfahrtszeit an der Starthaltestelle.
			// > Definition Zeitfenster
			// > GueltigVon: Beginn des Zeitfensters für die Solldatenübertragung.
			// > GueltigBis: Ende des Zeitfensters für die Solldatenübertragung. – Falls das Ende einer Fahrt außerhalb des angegebenen Zeitfensters liegt, werden dennoch die Daten der ganzen Fahrt übertragen.
			// VDV-453 spec
			x('Zeitfenster', {}, [
				x('GueltigVon', {}, getZst(validFrom)),
				x('GueltigBis', {}, getZst(validUntil)),
			]),
			// todo: Zeitfenster
			// todo: does LinienFilter work with REF_AUS?
			// todo: BetreiberFilter
			// todo: ProduktFilter
			// todo: VekehrsmittelTextFilter
			// todo: HaltFilter
			// todo: UmlaufFilter
			// todo: MitGesAnschluss
			// todo: MitBereitsAktivenFahrten
			// todo: MitFormation
		]
		return await _subscribe(
			REF_AUS,
			aboSubChildren,
			expiresAt,
			_fetchNewRefAusDataUntilNoMoreAvailable,
			fetchInterval,
		)
	}
	const refAusUnsubscribe = async (...aboIds) => {
		return await _unsubscribe(REF_AUS, aboIds)
	}
	const refAusUnsubscribeAll = async () => {
		return await _unsubscribeAll(REF_AUS)
	}

	const _fetchNewRefAusDataOnce = async (cfg) => {
		const {
			abortController,
		} = cfg

		// todo: does this exist for REF_AUS? does this make sense? would it make sense for *all* services?
		const datensatzAlle = true

		const hookCtx = {
			datensatzAlle,
			// todo: expose if this was a manual fetch or due to DatenBereitAnfrage!
		}

		await onRefAusFetchStarted(hookCtx)
		let nrOfSollFahrts = 0
		try {
			const els = _fetchDataOnce(REF_AUS, {
				datensatzAlle,
				abortController,
			})
			for await (const [linienfahrplan, ctx] of els) {
				// todo: `raw:ausref:Linienfahrplan` -> `raw:refaus:Linienfahrplan`
				data.emit(`raw:${REF_AUS}:Linienfahrplan`, linienfahrplan)
				// todo: trace-log linienfahrplan?

				for (const child of linienfahrplan.$children) {
					// todo: handle other `Linienfahrplan` children
					if (child.$name === 'SollFahrt') {
						data.emit(`raw:${REF_AUS}:SollFahrt`, child, linienfahrplan)

						const sollFahrt = parseRefAusSollFahrt(child, linienfahrplan, ctx)
						// todo: trace-log sollFahrt?
						nrOfSollFahrts++
						data.emit(`${REF_AUS}:SollFahrt`, sollFahrt)
					} else if (!PARSED_LINIENFAHRPLAN_CHILDREN.has(child.$name)) {
						// todo: warn-log?
					}
				}
			}
		} catch (err) {
			await onRefAusFetchFailed(hookCtx, err, {
				nrOfSollFahrts,
			})
			throw err
		}
		await onRefAusFetchSucceeded(hookCtx, {
			nrOfSollFahrts,
		})
	}

	// user-triggered manual fetch
	const refAusFetchData = async (opt = {}) => {
		const {
			abortController,
		} = {
			abortController: new AbortController(),
			...opt,
		}
		await _fetchNewRefAusDataOnce({
			abortController,
		})
	}

	// fetch triggered by the data provider, or by the subscription's manual fetch interval
	const _fetchNewRefAusDataUntilNoMoreAvailable = async (maxIterations) => {
		await _fetchNewDataUntilNoMoreAvailable(REF_AUS, _fetchNewRefAusDataOnce, maxIterations)
	}
	_handleDatenBereitAnfrage(AUS, _fetchNewRefAusDataUntilNoMoreAvailable)

	const refAusCheckServerStatus = async () => {
		return await _sendStatusAnfrage(REF_AUS)
	}

	// ----------------------------------

	const ausSubscribe = async (opt = {}) => {
		const {
			expiresAt,
			// linienId,
			// richtungsId,
			vorschauzeit,
			hysterese,
			fetchInterval,
		} = {
			expiresAt: Date.now() + AUS_DEFAULT_SUBSCRIPTION_TTL,
			// linienId: null,
			// richtungsId: null,
			vorschauzeit: 10, // minutes
			// VDV-454 spec v2.2.1 says:
			// > 5.2.1 Ist-Daten Anfrage (AboAUS)
			// > […]
			// > Schwellwert in Sekunden, ab dem Abweichungen vom Soll-Fahrplan bzw. von der letzten Meldung übertragen werden sollen (s. 6.1.8).
			// > Die Abweichung muss größer oder gleich dem angegebenen Wert sein, damit Abweichungen übertragen werden.
			// > […]
			// > 6.1.8 Zeitliches Meldeverhalten - Hysterese
			// > […]
			// > Das zeitliche Meldeverhalten bei Fahrtverspätungen ist dagegen relativ zur letzten Meldung in Form einer Hysteresefunktion festgelegt: Sobald sich eine Verspätungsprognose einer Haltestelle gegenüber dem letzten übermittelten Wert um die abonnierte Hysterese (oder mehr) nach oben oder unten verändert, setzt das ITCS eine Ist-Meldung an das Auskunftssystem ab, welche die alten Werte überschreibt.
			// The VBB VDV-453 server reports:
			// > Die Hysterese des Lieferanten "VBB DDS" ist 60 Sekunden […].
			// todo: does a lower value work too? nowadays many clients would be interested in delays <60s...
			hysterese: 60, // seconds
			// todo [breaking]: rename to `manualFetchInterval`
			fetchInterval: 30_000, // 30s
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
		return await _subscribe(
			AUS,
			aboSubChildren,
			expiresAt,
			_fetchNewAusDataUntilNoMoreAvailable,
			fetchInterval,
		)
	}
	const ausUnsubscribe = async (...aboIds) => {
		return await _unsubscribe(AUS, aboIds)
	}
	const ausUnsubscribeAll = async () => {
		return await _unsubscribeAll(AUS)
	}

	const _fetchNewAusDataOnce = async (cfg) => {
		const {
			abortController,
		} = cfg

		const hookCtx = {
			datensatzAlle,
			// todo: expose if this was a manual fetch or due to DatenBereitAnfrage!
		}

		await onAusFetchStarted(hookCtx)
		let nrOfIstFahrts = 0
		try {
			const els = _fetchDataOnce(AUS, {
				datensatzAlle,
				abortController,
			})
			for await (const [ausNachricht, ctx] of els) {
				const {zst} = ctx

				data.emit(`raw:${AUS}:AUSNachricht`, ausNachricht)
				for (const child of ausNachricht.$children) {
					// e.g. `raw:aus:IstFahrt`
					data.emit(`raw:${AUS}:${child.$name}`, child)
					if (child.$name === 'IstFahrt') {
						const istFahrt = parseAusIstFahrt(child, ctx)
						nrOfIstFahrts++
						data.emit(`${AUS}:IstFahrt`, istFahrt)
					}
				}
			}
		} catch (err) {
			await onAusFetchFailed(hookCtx, err, {
				nrOfIstFahrts,
			})
			throw err
		}
		await onAusFetchSucceeded(hookCtx, {
			nrOfIstFahrts,
		})
	}

	// user-triggered manual fetch
	const ausFetchData = async (opt = {}) => {
		const {
			abortController,
		} = {
			abortController: new AbortController(),
			...opt,
		}
		await _fetchNewAusDataOnce({
			abortController,
		})
	}

	// fetch triggered by the data provider, or by the subscription's manual fetch interval
	const _fetchNewAusDataUntilNoMoreAvailable = async (maxIterations) => {
		await _fetchNewDataUntilNoMoreAvailable(AUS, _fetchNewAusDataOnce, maxIterations)
	}
	_handleDatenBereitAnfrage(AUS, _fetchNewAusDataUntilNoMoreAvailable)

	const ausCheckServerStatus = async () => {
		return await _sendStatusAnfrage(AUS)
	}

	// ----------------------------------

	router.use(errorHandler)

	const httpServer = createHttpServer((req, res) => {
		const final = () => {
			// The `createServer()` should always have responded already, on both failures and successful handling.
			// However, we may get weird requests by the VDV API – or anyone else if the HTTP server is publicly available by accident –, so we just warn-log.
			if (!res.headersSent) {
				logger.warn({
					req,
					res,
				}, `router did not handle the request (${req.method} ${req.url})`)
				res.statusCode = 404
				res.end()
			}
		}
		router(req, res, final)
	})

	return {
		logger,
		sendRequest,
		httpServer,
		data,
		getAllSubscriptions,
		dfiSubscribe,
		dfiUnsubscribe,
		dfiUnsubscribeAll,
		dfiFetchData,
		dfiCheckServerStatus,
		refAusSubscribe,
		refAusUnsubscribe,
		refAusUnsubscribeAll,
		refAusFetchData,
		refAusCheckServerStatus,
		ausSubscribe,
		ausUnsubscribe,
		ausUnsubscribeAll,
		ausFetchData,
		ausCheckServerStatus,
		unsubscribeAllOwned,
	}
}

export {
	Vdv453HttpError, Vdv453ApiError,
	SERVICES,
	CLIENT_CALLS, SERVER_CALLS, ALL_CALLS,
	createClient,
}
