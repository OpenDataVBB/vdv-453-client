'use strict'

import createDebug from 'debug'
import {strictEqual, ok} from 'assert'
import {parse as parseContentType} from 'content-type'
import {createServer} from 'http'
import {createXmlParser} from './lib/xml-parser.js'

const debug = createDebug('vdv-453-client')
const debugIncomingHttp = createDebug('vdv-453-client:http:incoming')

// This implementation follows the VDV 453 spec, as documented in the "VDV-453 Ist-Daten-Schnittstelle – Version 3.0" document.
// https://web.archive.org/web/20220411145248/https://www.vdv.de/service/downloads_onp.aspx?id=4337&forced=False
// see also https://web.archive.org/web/20220411144928/https://www.vdv.de/i-d-s-downloads.aspx

// > 5.2 Http-Bindung -> 5.2.3 Dienstekennungen
// > …
// > Zurzeit werden durch die Online-Schnittstelle die folgenden Dienste unterstützt:
// > Referenzdatendienst Anschlusssicherung
// > ansref
// > Stellt serverseitig die Planungsdaten für Zubringer zur Verfügung. Diese werden clientseitig in der Anschlusssicherung verarbeitet.
const ANS_REF = 'ansref'
// > Prozessdatendienst Anschlusssicherung
// > ans
// > Stellt serverseitig die aktuellen Istdaten für Zubringer zur Verfügung. Diese werden clientseitig in der Anschlusssicherung verarbeitet.
const ANS = 'ans'
// > Referenzdatendienst Fahrgastinformation
// > dfiref
// > Stellt serverseitig Abfahrtstafeln für referenzdatenversorgte DFI bereit.
const DFI_REF = 'dfiref'
// > Prozessdatendienst Fahrgastinformation
// > dfi
// > Stellt serverseitig die Daten zur Fahrgastinformation zur Verfügung. Diese werden clientseitig auf den entsprechenden Anzeigern dargestellt
const DFI = 'dfi'
// > Visualisierung von Fahrten
// > vis
// > Stellt serverseitig Fahrtdaten zur Verfügung, die clientseitig auf der Leitstelle visualisiert werden.
const VIS = 'vis'
// > Nachrichtendienst
// > and
// > Stellt serverseitig textuelle Meldungen zur Verfügung.
const AND = 'and'
const SERVICES = [
	ANS_REF, ANS,
	DFI_REF, DFI,
	VIS,
	AND,
]

// > 5.2 Http-Bindung -> 5.2.4 Anfrage-URL
// > Alle Anfragen müssen an bestimmte Ziel-URLs gerichtet werden. Die Anfrage-URL ist sowohl vom Dienst als auch vom Typ der Anfrage abhängig.
// > Status abfragen
// > status.xml
// > Mit dieser Anfrage kann getestet werden, ob ein Dienst auf dem angefragten Server antwortet. Als Antwort werden die Leitsystemkennung und die Dienstkennung übertragen. Diese Anfrage dient auch der zyklischen Verbindungsüberwachung.
const STATUS = 'status.xml'
// > Client-Status abfragen
// > clientstatus.xml
// > Möchte der Server den Status vom Client überprüfen, schickt er eine ClientStatusAnfrage an den Client und wartet auf eine Antwort (ClientStatusAntwort).
const CLIENT_STATUS = 'clientstatus.xml'
// > DatenAbonnement verwalten
// > aboverwalten.xml
// > Mit dieser Anfrage können Online-Daten beim angefragten Leitsystem abonniert oder bestehende Abonnemente können gelöscht werden. Als Antwort wird die Annahme der Anfrage bestätigt oder im Fehlerfall eine entsprechende Fehlermeldung gesendet.
const ABO_VERWALTEN = 'aboverwalten.xml'
// > Datenbereit melden
// > datenbereit.xml
// > Mit dieser Anfrage kann einem Partnersystem signalisiert werden, dass Daten zur Abholung bereitliegen. Das Partnersystem leitet daraufhin mit einer Anfrage "Daten übertragen" die Übertragung der Daten ein. Als Antwort wird die Annahme der Anfrage bestätigt oder eine Fehlermeldung gesendet.
const DATEN_BEREIT = 'datenbereit.xml'
// > Daten abrufen
// > datenabrufen.xml
// > Mit dieser Anfrage können Online-Daten abgerufen werden. Als Antwort werden die bereitliegenden Daten oder eine Fehlermeldung übertragen.
const DATEN_ABRUFEN = 'datenabrufen.xml'
const TARGETS = [
	STATUS, CLIENT_STATUS,
	ABO_VERWALTEN,
	DATEN_BEREIT, DATEN_ABRUFEN,
]

class ServerRequestError extends Error {
	constructor (req, statusCode, statusMessage) {
		super(`${req.method} ${req.url}: ${statusMessage}`)
		// this.httpRequest = req
		this.responseStatusCode = statusCode
		this.responseStatusMessage = statusMessage
		return this
	}
}
// const respondWithError = (res, statusCode, statusMessage) => {
// 	res.statusCode = statusCode
// 	res.statusMessage = statusMessage
// 	// todo: send proper XML error message
// 	res.end()
// }

const createClient = (cfg, opt = {}) => {
	const {
		logger,
		endpoint,
	} = cfg
	const {
	} = {
		parseXmlWithPosition: process.env.NODE_ENV !== 'production',
		...opt,
	}

	strictEqual(typeof endpoint, 'string', 'cfg.endpoint must be a string')
	ok(endpoint, 'cfg.endpoint must not be empty')

	const onHttpRequest = (req, res) => {
		debugIncomingHttp(req.method, req.url, req.rawHeaders)

		try {
			// todo: check req protocol?
			// todo: do the server requests have auth?

			// > 5.2 Http-Bindung -> 5.2.1 Verfahren
			// > Der Nachrichtenaustausch über HTTP oder HTTPS erfolgt über die Methode POST.
			if (req.method !== 'POST') {
				throw new ServerRequestError(req, 405, 'POST only')
			}

			// > 5.2 Http-Bindung -> 5.2.1 Verfahren
			// > Beispiel HTTP-POST:
			// > POST /leitsystem1/ans/status.xml HTTP/1.1
			// > …
			// > Content-Type: text/xml
			// > …
			// > HTTP/1.1 200 OK
			// > Content-Type: text/xml Charset="utf-8"
			// (note the invalid Content-Type header format 🙄)
			if (!req.headers['content-type']) {
				throw new ServerRequestError(req, 400, 'missing Content-Type header')
			}
			const cType = parseContentType(req.headers['content-type'])
			if (cType.type !== 'text/xml') {
				throw new ServerRequestError(req, 400, `invalid content type "${cType.type}"`)
			}
			// > 5.2 Http-Bindung -> 5.2.2 Zeichensatz
			// > Es wird ausschließlich der Zeichensatz UTF-8 verwendet.
			const charset = cType.parameters.Charset || cType.parameters.charset || null
			if (charset && charset.toLowerCase() !== 'utf-8') {
				throw new ServerRequestError(req, 400, `invalid content type "${charset}"`)
			}

			const {pathname: path} = new URL(req.url, 'http://example.org')
			// > 5.2 Http-Bindung -> 5.2.4 Anfrage-URL
			// > Gibt den Pfad der Anfrage an.
			// > Definition abs_path für die Online-Schnittstelle:
			// > abs_path = "/" leitstellenkennung "/" dienstkennung "/" anfragekennung
			const [_, todo, service, target] = path.split('/')
			if (!SERVICES.inclues(service)) {
				throw new ServerRequestError(req, 404, `invalid service "${service}"`)
			}
			if (!TARGETS.inclues(target)) {
				throw new ServerRequestError(req, 404, `invalid target "${target}"`)
			}
		} catch (err) {
			if (err instanceof ServerRequestError) {
				res.statusCode = err.responseStatusCode
				res.statusMessage = err.responseStatusMessage
			} else {
				res.statusCode = 500
				res.statusMessage = err.message
			}

			logger.warn({
				req,
			}, err.message)
			// todo: send proper XML error message
			res.end()
			return;
		}

		const parser = createXmlParser((bestaetigung, weitereDaten) => {
			// todo
		})
		req.pipe(parser)

		// todo: http keepalive?
		// todo: handle request, send response
	}

	const server = createServer(onHttpRequest)
	return {
		server,
	}
}

export {
	SERVICES,
	TARGETS,
	createClient,
}
