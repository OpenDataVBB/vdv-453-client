'use strict'

import pino from 'pino'
import {strictEqual, ok} from 'node:assert'
import {EventEmitter} from 'node:events'
import {createServer as createHttpServer} from 'node:http'
import {x} from 'xastscript'
import {CLIENT_CALLS, SERVER_CALLS, ALL_CALLS} from './lib/calls.js'
import {
	createSendRequest,
	BESTAETIGUNG,
	Vdv453HttpError, Vdv453ApiError,
} from './lib/send-request.js'
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

// > When delay is larger than 2147483647 or less than 1, the delay will be set to 1. Non-integer delays are truncated to an integer.
// https://nodejs.org/docs/latest-v20.x/api/timers.html#settimeoutcallback-delay-args
const SETTIMEOUT_MAX_DELAY = 2147483647

const DFI_DEFAULT_SUBSCRIPTION_TTL = 1 * HOUR
const AUS_DEFAULT_SUBSCRIPTION_TTL = 1 * HOUR

const SUBSCRIPTION_EXPIRED_MSG = 'subscription expired'

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

// This implementation follows the VDV 453 spec, as documented in the "VDV-453 Ist-Daten-Schnittstelle – Version 2.6.1" document. It also supports the VDV 454 extension, as documented in the "VDV-454 Ist-Daten-Schnittstelle – Fahrplanauskunft – Version 2.2.1".
// https://web.archive.org/web/20231208122259/https://www.vdv.de/vdv-schrift-453-v2.6.1-de.pdfx?forced=true
// https://web.archive.org/web/20231208122259/https://www.vdv.de/454v2.2.1-sd.pdfx?forced=true
// see also https://web.archive.org/web/20231208122259/https://www.vdv.de/i-d-s-downloads.aspx

const createClient = (cfg, opt = {}) => {
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
		onDatenBereitAnfrage,
		onClientStatusAnfrage,
		onStatusAntwort,
		onSubscribed,
		onSubscriptionExpired,
		onSubscriptionCanceled,
		onSubscriptionManualFetchStarted,
		onSubscriptionManualFetchSucceeded,
		onSubscriptionManualFetchFailed,
		onDatenAbrufenAntwort,
		onDataFetchStarted,
		onDataFetchSucceeded,
		onDataFetchFailed,
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
		// hooks for debugging/metrics/etc.
		onDatenBereitAnfrage: (svc, datenBereitAnfrage) => {},
		onClientStatusAnfrage: (svc, clientStatusAnfrage) => {},
		onStatusAntwort: (svc, statusAntwort) => {},
		onSubscribed: (svc, {aboId, aboSubTag, aboSubChildren}, bestaetigung, subStats) => {},
		onSubscriptionExpired: (svc, {aboId, aboSubTag, aboSubChildren}, subStats) => {},
		onSubscriptionCanceled: (svc, {aboId, aboSubTag, aboSubChildren}, reason, subStats) => {},
		onSubscriptionManualFetchStarted: (svc, {aboId, aboSubTag, aboSubChildren}) => {},
		onSubscriptionManualFetchSucceeded: (svc, {aboId, aboSubTag, aboSubChildren}, {timePassed}) => {},
		onSubscriptionManualFetchFailed: (svc, {aboId, aboSubTag, aboSubChildren}) => {},
		onDatenAbrufenAntwort: (svc, {datensatzAlle, weitereDaten, itLevel, bestaetigung}) => {},
		onDataFetchStarted: (svc, {datensatzAlle}) => {},
		onDataFetchSucceeded: (svc, {datensatzAlle}, {nrOfFetches, timePassed}) => {},
		onDataFetchFailed: (svc, {datensatzAlle}, err, {nrOfFetches, timePassed}) => {},
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

	const sendRequest = createSendRequest({
		...cfg,
		logger: requestsLogger,
	}, opt)
	const {router, errorHandler} = createServer(cfg, opt)

	// todo: serve basic information about the service on /

	const data = new EventEmitter()

	// ----------------------------------

	const startDienstZst = getZst()

	// Technically, we don't need globally unique subscription IDs.
	// > 5.1.1 Überblick
	// > Eine AboID ist innerhalb eines jeden Dienstes eindeutig.
	const getNextAboId = () => String(10000 + Math.round(Math.random() * 9999))
	// todo: "Wird eine AboAnfrage mit einer AboID gestellt und es existiert bereits ein Abonnement unter dieser Bezeichnung, so wird das bestehende Abonnement überschrieben." – warn about this? does it apply across services?
	// todo: persist AboIDs across client restarts, reinstate fetch timers after restarts? – transactions (or locking as a fallback) will be necessary to guarantee consistent client behaviour (start transaction, set up subscription, upon success persist AboId, commit transaction)
	// service -> AboID -> subscriptionAbortController
	const subscriptions = Object.fromEntries(
		SERVICES.map(svc => [svc, new Map()]),
	)

	// todo: make configurable with a decent UX
	const datensatzAlle = false

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
					// > 5.1.8.3 ClientStatusAnfrage
					// > […]
					// > Stellt der Server einen Unterschied zwischen seiner Abonnementliste und der Liste vom Client, kann der Server entweder stillschweigend den Unterschied beseitigen indem er die nicht aus der Clientsicht aktiven Abonnements löscht und die aus der Clientsicht aktiven Abonnements registriert und anfängt für diese Daten bereitzustellen oder er setzt den StartDienstZst in seiner StatusAntwort auf die aktuelle Zeit und erzwingt somit die Neuinitiali- sierung des Clients. Der zweite Weg wird empfohlen.
					// > Ist die Struktur AktiveAbos leer, hat der Client keine aktiven Abonnements. Falls der Server doch welche kennt, sollen diese stillschweigend deaktiviert werden.
				],
			})

			await onClientStatusAnfrage(service, clientStatusAnfrage)
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
		for await (const el of tags) {
			const tag = el.$name
			if (tag === 'StatusAntwort') {
				assertStatusAntwortOk(el)

				logger.debug({
					service,
					statusAntwort: el,
				}, 'received StatusAntwort')
				await onStatusAntwort(service, el)
				return el
			}
			// todo: otherwise warn-log unexpected tag?
		}
	}
	// todo: send StatusAnfrage periodically, to detect client & server hiccups
	// > Verliert der Server seine Abonnement-Daten, so ist dies zunächst vom Client aus nicht fest- stellbar. DatenBereitAnfragen bleiben zwar aus, aber dies kann nicht vom normalen Betrieb unterschieden und somit der Absturz des Servers nicht festgestellt werden. Um diesen Fall zu erkennen, sind zusätzliche, zyklische Anfragen vom Typ StatusAnfrage (5.1.8.1) zum Server zu senden. Innerhalb der StatusAntwort (5.1.8.2) gibt der Server den Zeitstempel des Dienststarts an. Fand der Dienststart nach der Einrichtung der Abonnements statt, so muss vom Verlust der Abonnements ausgegangen werden. Es ist nun zu verfahren wie beim Client-Datenverlust: Löschen und Neueinrichtung aller Abonnements.
	// todo: what happens if the client discovers that the server has active subscriptions that the client doesn't know about? if the client is the single instance subscribing, it should provide a way to delete such stale/"stray" subscriptions

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
		for await (const el of tags) {
			const tag = el.$name
			if (tag === BESTAETIGUNG) {
				assertBestaetigungOk(el)
				// todo: warn if DatenGueltigBis < aboParams.VerfallZst?
				// > (optional) Ende des Datenhorizontes des Datenproduzenten. Entfällt, wenn Anfrage vollständig im Datenhorizont liegt.
				// todo: add hook onAboAntwort()?
				return el
			}
			// todo: otherwise warn-log unexpected tag?
		}
	}

	// subscriptionAbortController -> timer
	const _expirationTimersBySubAbortController = new WeakMap()
	const _subscribe = async (service, aboSubChildren, expiresAt, fetchNewDataOnce, fetchInterval) => {
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

		const getSubStats = () => ({
			nrOfSubscriptions: subscriptions[service].size,
		})

		const aboParams = [
			x(aboSubTag, {
				AboID: aboId,
				VerfallZst: getZst(expiresAt),
			}, aboSubChildren)
		]

		const subscriptionAbortController = new AbortController()
		// keep track of the subscription using the `aboID`
		// We do this before sending the request because we might crash while the request is in-flight.
		// todo: do this after the request has been sent?
		subscriptions[service].set(aboId, subscriptionAbortController)

		// on abort, call hooks
		subscriptionAbortController.signal.addEventListener('abort', () => {
			if (subscriptionAbortController.signal.reason === SUBSCRIPTION_EXPIRED_MSG) {
				onSubscriptionExpired(service, logCtx, getSubStats())
				?.catch(() => {}) // silence errors
			} else {
				onSubscriptionCanceled(service, logCtx, subscriptionAbortController.signal.reason, getSubStats())
				?.catch(() => {}) // silence errors
			}
		})

		// expiration timer fires -> abort subscription
		// subscription aborted externally -> clear expiration timer
		{
			const expireSubClientSide = () => {
				logger.trace(logCtx, 'expiring subscription client-side')
				// Note: We delete from `subscriptions` before abort()-ing.
				subscriptions[service].delete(aboId)
				subscriptionAbortController.abort(SUBSCRIPTION_EXPIRED_MSG)
			}

			const expirationTimer = setTimeout(expireSubClientSide, expiresIn)
			expirationTimer.unref() // todo: is this correct?
			_expirationTimersBySubAbortController.set(subscriptionAbortController, expirationTimer)

			// clear expiration timer on external subscription abort
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

		const bestaetigung = await _sendAboAnfrage(
			service,
			aboParams,
		)
		await onSubscribed(service, logCtx, bestaetigung, getSubStats())

		if (fetchSubscriptionsDataPeriodically) {
			ok(Number.isInteger(fetchInterval), 'fetchInterval must be an integer')

			const fetchPeriodicallyAndLogErrors = async () => {
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
						await fetchNewDateOnce({
							abortController: fetchAbortController,
						})
						const timePassed = performance.now() - t0

						await onSubscriptionManualFetchSucceeded(service, logCtx, {
							timePassed,
						})
					} catch (err) {
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

		logger.trace({
			...logCtx,
			bestaetigung,
		}, 'successfully subscribed')
		return {
			aboId,
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
			if (silenceSubscriptionNotFoundError) {
				const match = /zu löschenden Abonnements (\d+(, \d+)?) wurden nicht gefunden/i.exec(err.message)
				if (match && match[1]) {
					logCtx.notFoundAboIds = match[1].split(', ')
					return;
				}
			}
			throw err
		}

		for (const aboId of aboIds) {
			const abortController = subscriptions[service].get(aboId)
			if (!abortController) {
				continue
			}
			// Note: We delete from `subscriptions` before abort()-ing.
			subscriptions[service].delete(aboId)
			abortController.abort('unsubscribed manually')
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

		for (const [aboId, abortController] of subscriptions[service].entries()) {
			// Note: We delete from `subscriptions` before abort()-ing.
			subscriptions[service].delete(aboId)
			abortController.abort('unsubscribed manually')
		}
		logger.debug(logCtx, 'successfully unsubscribed from all subscriptions')
	}

	const unsubscribeAllOwned = async () => {
		await Promise.all(Object.entries(subscriptions).map(async ([service, subs]) => {
			const aboIds = Array.from(subs.keys())
			if (aboIds.length === 0) return;
			await _unsubscribe(service, aboIds, true)
		}))
	}

	// The server should notify the client of new/changed data, so that the latter can then request it.
	// > 5.1.3.1 Datenbereitstellung signalisieren (DatenBereitAnfrage)
	// > Ist das Abonnement eingerichtet und sind die Daten bereitgestellt, wird der Datenkonsument durch eine DatenBereitAnfrage über das Vorhandensein aktualisierter Daten informiert. Dies geschieht bei jeder Änderung der Daten die dem Abonnement zugeordnet sind. Die Signalisierung bezieht sich auf alle Abonnements eines Dienstes.
	const _handleDatenBereitAnfrage = (service, fetchNewDataOnce) => {
		const _processDatenBereitAnfrage = async (req, res) => {
			const logCtx = {
				service,
			}

			if (subscriptions[service].size === 0) { // 0 subscriptions on `service`
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

			try {
				await fetchNewDataOnce({
					// There is no reasonable way to abort here, so we make a dummy AbortController.
					abortController: new AbortController(),
				})
			} catch (err) {
				logger.warn({
					service,
					err,
				}, `failed to handle DatenBereitAnfrage: ${err.message}`)
			}
		}
		_onRequest(service, DATEN_BEREIT, _processDatenBereitAnfrage)
	}

	// todo:
	// > 5.1.4.1 Datenübertragung anfordern (DatenAbrufenAnfrage)
	// > Wurde bereits eine DatenAbrufenAnfrage vom Client an den Server versandt, so ist für diese vom Client eine DatenAbrufenAntwort abzuwarten (Antwort, oder Timeout), bevor erneut eine DatenAbrufenAnfrage versandt wird. Es wird daher empfohlen keine weitere DatenAbrufenAnfrage zu stellen, solange noch eine DatenAbrufenAnfrage aktiv ist.
	const WEITERE_DATEN = 'WeitereDaten'
	const DATEN_ABRUFEN_MAX_ITERATIONS = 300

	// We need to fetch data in >1 pages. For better consumer ergonomics, we expose it as *one* async iterable. We also want to process each response's body iteratively. Effectively, by using async iteration, we signal "backpressure" to the response parsing code.
	// However, `yield*` (and the non-async-iterable `await`) with recursive function calls prevents Node.js from garbage-collecting allocations of the caller. [0]
	// This is why we use a trampoline [1] here. Because we use `yield*`, we cannot use the (inner function's) return value to signal if iteration/recursion should continue, so we use an object instead.
	// [0] https://medium.com/@RomarioDiaz25/the-problem-with-infinite-recursive-promise-resolution-chains-af5b97712661
	// [1] https://stackoverflow.com/a/489860/1072129
	const _fetchDataOnce = async function* (service, opt) {
		await onDataFetchStarted(service, opt)

		let timePassed = null
		let itLevel = 0
		try {
			const t0 = performance.now()
			const itControl = {
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
		if (itLevel >= DATEN_ABRUFEN_MAX_ITERATIONS) {
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
			fetchInterval,
		} = {
			expiresAt: Date.now() + DFI_DEFAULT_SUBSCRIPTION_TTL,
			linienId: null,
			richtungsId: null,
			vorschauzeit: 10, // minutes
			// todo: is `0` possible? does it provide more data?
			hysterese: 1, // seconds
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
			_fetchNewDfiDataOnce,
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
	_handleDatenBereitAnfrage(DFI, _fetchNewDfiDataOnce)

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
			_fetchNewAusDataOnce,
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
	_handleDatenBereitAnfrage(AUS, _fetchNewAusDataOnce)

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
		dfiFetchData,
		ausSubscribe,
		ausUnsubscribe,
		ausUnsubscribeAll,
		ausFetchData,
		unsubscribeAllOwned,
	}
}

export {
	Vdv453HttpError, Vdv453ApiError,
	SERVICES,
	CLIENT_CALLS, SERVER_CALLS, ALL_CALLS,
	createClient,
}
