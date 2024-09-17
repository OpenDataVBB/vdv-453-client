# vdv-453-client

**A client for realtime public transport data systems following the [VDV-453 v2.3.2b](https://web.archive.org/web/20231208122259/https://www.vdv.de/453v2.3.2-sds.pdf.pdfx?forced=false)/[VDV-454 v1.2.2](https://web.archive.org/web/20231208122259/https://www.vdv.de/454v1.2.2-sds.pdf.pdfx?forced=false) specs** (from 2013). Such systems are widespread in Germany, being the realtime data backends (*Datendrehscheiben*) of many regional transit authorities/associations.

> [!NOTE]
> This client supports neither the latest 2.x spec versions ([VDV-453 v2.6.1](https://www.vdv.de/vdv-schrift-453-v2.6.1-de.pdfx?forced=true)/[VDV-454 v2.2.1](https://www.vdv.de/454v2.2.1-sd.pdfx?forced=true)) nor the latest 3.x spec versions ([VDV-453 v3.0](https://www.vdv.de/downloads/4337/453v3.0%20SDS/forced)/[VDV-454 v3.0](https://www.vdv.de/downloads/4336/454v3.0%20SDS/forced)). Refer to the [tracking Issue #2](https://github.com/OpenDataVBB/vdv-453-client/issues/2).

[![npm version](https://img.shields.io/npm/v/vdv-453-client.svg)](https://www.npmjs.com/package/vdv-453-client)
![ISC-licensed](https://img.shields.io/github/license/OpenDataVBB/vdv-453-client.svg)
![minimum Node.js version](https://img.shields.io/node/v/vdv-453-client.svg)
[![chat with me on Twitter](https://img.shields.io/badge/chat%20with%20me-on%20Twitter-1da1f2.svg)](https://twitter.com/derhuerst)

The VDV-453 spec defines the basic protocol that client (usually the data consumer) and server (usually the provider) use to communicate; It uses HTTP `POST` requests with XML bodies. VDV-453 also defines some (domain-specific) *services* on top, e.g. `DFI` for fetching departures at stops/stations. The client subscribes to such services, optionally with service-specific parameters, e.g. filters to reduce the number of subscribed items.

On top of VDV-453, VDV-454 defines two additional services: `REF-AUS` for the exchange of daily schedule data, and `AUS` for realtime data like prognosed delays & cancellations.

## Installation

```shell
npm install OpenDataVBB/vdv-453-client
```


## Usage

### Leitstellenkennung

With the organisation providing the VDV 453 API, you will have to agree upon your client's *Leitstellenkennung*, which – a bit like an HTTP User-Agent – allows the server to identify your client:

> 6.1.3 Leitstellenkennung
>
> Um Botschaften verschiedener Kommunikationspartner innerhalb eines Dienstes unterscheiden zu können, enthält jede Nachricht eine eindeutige Leitstellenkennung (Attribut `Sender`) des nachfragenden Systems. […]

```js
const LEITSTELLE = 'MY_VDV_CLIENT'
```

### server address

We configure the server's address. It needs to be the HTTP(S) base URL *without* your *Leitstellenkennung*.

```js
const ENDPOINT = 'http://vdv-api.example.org/'
```

### local HTTP server

> ![NOTE]
> The VDV-453 spec expects the *client* (consumer) to listen for HTTP requests from the *server* (provider), in order to allow the server to notify the client when new data is available, sort of like a [webhook](https://en.wikipedia.org/wiki/Webhook).
> This means that your client's machine will have to have an open TCP port! Once you have chosen your client's port, it needs to be configured on the server side.

> 5.1.3.1 Datenbereitstellung signalisieren (`DatenBereitAnfrage`)
>
> Ist das Abonnement eingerichtet und sind die Daten bereitgestellt, wird der Datenkonsument durch eine `DatenBereitAnfrage` über das Vorhandensein aktualisierter Daten informiert.

> 5.1.8 Alive-Handling
>
> Die Statusabfrage dient dem Feststellen der Verfügbarkeit von Diensten. Dazu werden zwei spezielle Informationskanäle verwendet (Ziel-URL `status.xml`, `clientstatus.xml`), die jeder Dienst bereitstellen muss.

We strongly recommend you to follow the spec and allow such incoming requests!

### configuring the client

```js
import {createClient as createVdv453Client} from 'vdv-453-client'

const {
	httpServer,
	data,
	dfiSubscribe,
	dfiUnsubscribe,
	ausSubscribe,
	ausUnsubscribe,
} = createVdv453Client({
	leitstelle: LEITSTELLE,
	endpoint: ENDPOINT,
})

// createClient() returns an HTTP server, which you still need to call listen() on.
await new Promise((resolve, reject) => {
	httpServer.listen(3000, (err) => {
		if (err) reject(err)
		else resolve()
	})
})

const unsubscribeTasks = []
process.once('SIGINT', {
	Promise.all(unsubscribeTasks.map(task => task()))
	.then(() => {
		httpServer.close()
	})
	.catch((err) => {
		console.error(err)
		process.exit(1)
	})
})
```

### subscribing to services

By design, every VDV-453/-454 subscription must have a [TTL](https://en.wikipedia.org/wiki/Time_to_live) – in other words: a pre-set point in time at which it expires.

> 5.1.1 Abonnement-Verfahren – Überblick
>
> […]
>
> Abonnements besitzen eine vom Client definierte Lebensspanne und werden nach Ablauf automatisch vom Server gelöscht. […]

> 5.1.2.1 Abonnementsanfrage (`AboAnfrage`)
>
> […]
>
> Allen Abonnements aller Dienste wird beim Einrichten ein Verfallszeitstempel (`VerfallZst`) durch den Client mitgegeben. […]

Therefore, when subscribing to a service, the client *must* provide am expiry date+time. Use `opt.expiresAt` to provide a different TTL than `vdv-453-client`'s default of 1 hour.

```js
// subscribe to VDV-453 DFI service
const {aboId: dfiAboId} = await dfiSubscribe()
unsubscribeTasks.push(() => dfiUnsubscribe(dfiAboId))
data.on('dfi:AZBNachricht', (azbNachricht) => {
	console.log(azbNachricht)
})

// subscribe to VDV-454 AUS service
const {aboId: ausAboId} = await ausSubscribe({
	expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes from now
})
unsubscribeTasks.push(() => ausUnsubscribe(ausAboId))
data.on('aus:IstFahrt', (istFahrt) => {
	console.log(istFahrt)
})
```


## Related

- [vdv-453-nats-adapter](https://github.com/OpenDataVBB/vdv-453-nats-adapter) – Send events from a VDV-453/VDV-454 endpoint to NATS (JetStream).


## Contributing

If you have a question or need support using `vdv-453-client`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, use [the issues page](https://github.com/OpenDataVBB/vdv-453-client/issues).
