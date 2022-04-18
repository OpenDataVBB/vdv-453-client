'use strict'

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

// client -> server requests
const CLIENT_CALLS = [
	STATUS,
	ABO_VERWALTEN,
	DATEN_ABRUFEN,
]
Object.assign(CLIENT_CALLS, {
	STATUS,
	ABO_VERWALTEN,
	DATEN_ABRUFEN,
})

// server -> client requests
const SERVER_CALLS = [
	CLIENT_STATUS,
	DATEN_BEREIT,
]
Object.assign(SERVER_CALLS, {
	CLIENT_STATUS,
	DATEN_BEREIT,
})

// all requests
const ALL_CALLS = [
	STATUS,
	ABO_VERWALTEN,
	DATEN_ABRUFEN,
	CLIENT_STATUS,
	DATEN_BEREIT,
]
Object.assign(ALL_CALLS, {
	STATUS,
	ABO_VERWALTEN,
	DATEN_ABRUFEN,
	CLIENT_STATUS,
	DATEN_BEREIT,
})

export {
	CLIENT_CALLS,
	SERVER_CALLS,
	ALL_CALLS,
}
