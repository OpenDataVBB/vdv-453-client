'use strict'

// > 5.2 Http-Bindung -> 5.2.3 Dienstekennungen
// > Die Bereitstellung bestimmter Daten und deren leitsystemübergreifende Verarbeitung werden in diesem Dokument als Dienst bezeichnet.
// > Zurzeit werden durch die Online-Schnittstelle die folgenden Dienste unterstützt:
// > Referenzdatendienst Anschlusssicherung
// > ansref
// > Stellt serverseitig die Planungsdaten für Zubringer zur Verfügung. Diese werden clientseitig in der Anschlusssicherung verarbeitet.
const REF_ANS = 'ansref'
// > Prozessdatendienst Anschlusssicherung
// > ans
// > Stellt serverseitig die aktuellen Istdaten für Zubringer zur Verfügung. Diese werden clientseitig in der Anschlusssicherung verarbeitet.
const ANS = 'ans'
// > Referenzdatendienst Fahrgastinformation
// > dfiref
// > Stellt serverseitig Abfahrtstafeln für referenzdatenversorgte DFI bereit.
const REF_DFI = 'dfiref'
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

// VDV 454 spec:
// > 4.4 Dienstekennung / Anfrage-URL
// > Jeder fachliche Dienst der VDV-453 besitzt eine eindeutige Kennung (siehe VDV-453, Kapitel 5.2.3). Für den Auskunftsdienst werden folgende Kennungen ergänzt:
// > - `ausref` für den Referenzdatendienst der Auskunftsschnittstelle
// > - `aus` für den Prozessdatendienst
const REF_AUS = 'ausref'
const AUS = 'aus'

const SERVICES = [
	REF_ANS, ANS,
	REF_DFI, DFI,
	VIS,
	AND,
	REF_AUS, AUS,
]

Object.assign(SERVICES, {
	REF_ANS, ANS,
	REF_DFI, DFI,
	VIS,
	AND,
	REF_AUS, AUS,
})

export {
	SERVICES,
}
