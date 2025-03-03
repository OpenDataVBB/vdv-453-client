# vdv-453-client

A JavaScript **client for realtime public transport data systems following the [VDV-453 v2.4.0](https://web.archive.org/web/20240221234602/https://www.vdv.de/453v24-sds.pdfx?forced=false)/[VDV-454 v2.0](https://web.archive.org/web/20240222010651/https://www.vdv.de/454v2.0-sd.pdfx?forced=false) specs** (from 2015). Such systems are widespread in Germany, being the realtime data backends (*Datendrehscheiben*) of many regional transit authorities/associations.

[![npm version](https://img.shields.io/npm/v/vdv-453-client.svg)](https://www.npmjs.com/package/vdv-453-client)
![ISC-licensed](https://img.shields.io/github/license/OpenDataVBB/vdv-453-client.svg)
![minimum Node.js version](https://img.shields.io/node/v/vdv-453-client.svg)
[![chat with me on Twitter](https://img.shields.io/badge/chat%20with%20me-on%20Twitter-1da1f2.svg)](https://twitter.com/derhuerst)

`vdv-453-client` is a library only, intended to be embedded into other tools (e.g. [vdv-453-nats-adapter](https://github.com/OpenDataVBB/vdv-453-nats-adapter)). It subscribes to services (see below), fetches the XML data, converts it to JSON, and emits it via an [event](https://nodejs.org/docs/latest-v20.x/api/events.html).

> [!NOTE]
> This client supports neither the latest 2.x spec versions ([VDV-453 v2.6.1](https://www.vdv.de/vdv-schrift-453-v2.6.1-de.pdfx?forced=true)/[VDV-454 v2.2.1](https://www.vdv.de/454v2.2.1-sd.pdfx?forced=true)) nor the latest 3.x spec versions ([VDV-453 v3.0](https://www.vdv.de/downloads/4337/453v3.0%20SDS/forced)/[VDV-454 v3.0](https://www.vdv.de/downloads/4336/454v3.0%20SDS/forced)). Refer to the [tracking Issue #2](https://github.com/OpenDataVBB/vdv-453-client/issues/2).

The VDV-453 spec defines the basic protocol that client (usually the data consumer) and server (usually the provider) use to communicate; It uses HTTP `POST` requests with XML bodies. VDV-453 also defines some (domain-specific) *services* on top, e.g. `DFI` for fetching departures at stops/stations. A client subscribes to such services, optionally with service-specific parameters, e.g. filters to reduce the number of subscribed items.

On top of VDV-453, VDV-454 defines two additional services: `REF-AUS` for the exchange of daily schedule data, and `AUS` for realtime data like prognosed delays & cancellations.

`vdv-453-client` has been written specifically for [VBB](https://en.wikipedia.org/wiki/Verkehrsverbund_Berlin-Brandenburg)'s *Datendrehscheibe*. However, we're open to changes that make `vdv-453-client` compatible with other VDV-453/-454 systems.


## Installation

```shell
npm install vdv-453-client
```


## Getting Started

> [!IMPORTANT]
> While `vdv-453-client` is used in a production system at VBB, it hasn't been tested with other VDV-453/-454 systems.
> Also, there's [tracking issue #1 regarding automated tests](https://github.com/OpenDataVBB/vdv-453-client/issues/1).

### Leitstellenkennung

With the organisation providing the VDV 453 API, you will have to agree upon your client's *Leitstellenkennung*, which – a bit like an HTTP User-Agent – allows the server to identify your client:

> 6.1.3 Leitstellenkennung
>
> Um Botschaften verschiedener Kommunikationspartner innerhalb eines Dienstes unterscheiden zu können, enthält jede Nachricht eine eindeutige Leitstellenkennung (Attribut `Sender`) des nachfragenden Systems. […]

```js
const LEITSTELLE = 'MY_VDV_CLIENT'
```

You will also have to configure their *Leitstellenkennung*, which they use for calls to your client.

```js
const THEIR_LEITSTELLE = 'SOME_VDV_API'
```

### server address

We configure the server's address. It needs to be the HTTP(S) base URL *without* your *Leitstellenkennung*.

```js
const ENDPOINT = 'http://vdv-api.example.org/'
```

### local HTTP server

> [!NOTE]
> The VDV-453 spec expects the *client* (consumer) to listen for HTTP requests from the *server* (provider), in order to allow the server to notify the client when new data is available, sort of like a [webhook](https://en.wikipedia.org/wiki/Webhook).
> This means that your client's machine will have to have an open TCP port! Once you have chosen your client's port, it needs to be configured on the server side.

> 5.1.3.1 Datenbereitstellung signalisieren (`DatenBereitAnfrage`)
>
> Ist das Abonnement eingerichtet und sind die Daten bereitgestellt, wird der Datenkonsument durch eine `DatenBereitAnfrage` über das Vorhandensein aktualisierter Daten informiert.

> 5.1.8 Alive-Handling
>
> Die Statusabfrage dient dem Feststellen der Verfügbarkeit von Diensten. Dazu werden zwei spezielle Informationskanäle verwendet (Ziel-URL `status.xml`, `clientstatus.xml`), die jeder Dienst bereitstellen muss.

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
	theirLeitstelle: THEIR_LEITSTELLE,
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

Therefore, when subscribing to a service, the client *must* provide an expiration date+time. Use `opt.expiresAt` to provide a different TTL than `vdv-453-client`'s default of 1 hour.

```js
// subscribe to VDV-453 DFI service
// the ID of the stop/station (a.k.a. "Anzeigerbereich") depends on your region's data
const SOME_ANZEIGERBEREICH_ID = 'my stop ID'
const {aboId: dfiAboId} = await dfiSubscribe(SOME_ANZEIGERBEREICH_ID)
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

> [!WARNING]
> Currently, `vdv-453-client` has some shortcomings in the handling of subscriptions; For example, it does not persist the information about its subscriptions, and it does not respond to the server with its active subscriptions (`AktiveAbos`) when asked. Refer to the [tracking Issue #3](https://github.com/OpenDataVBB/vdv-453-client/issues/3) for more details.


## API

> [!TIP]
> The `REF-AUS` & `AUS` services are defined in VDV-454. All other services are defined in VDV-453.

A client instance can be created by calling `createClient()`. This object is referred to as `client` below.

`createClient()` takes the following arguments:
1. `cfg`: an object with these fields:
	- `leitstelle`: the client's *Leitstellenkennung* (see the "Getting Started" section)
	- `theirLeitstelle`: the server's *Leitstellenkennung*
2. `opt`: an optional object whose fields override these defaults:
	- `logger`: used for general log messages; must be [pino](https://getpino.io/)-compatible
	- `requestsLogger`: used for logging HTTP requests/responses; must be [pino](https://getpino.io/)-compatible
	- `fetchSubscriptionsDataPeriodically`: if subscriptions' data should be fetched *manually* periodically, regardless of wether the server proactively reports new data using `DatenBereitAnfrage`s – default: `true`
	- `datenAbrufenMaxIterations`: When fetching all new data from the server, the maximum number of fetch iterations. The number of items per iterations depends on the server.
	- `on*()`: hooks for debug logging, keeping metrics, etc. (see the "Hooks" section)

### `client.httpServer`

The client HTTP server (see section above), an [`http.Server`](https://nodejs.org/docs/latest-v20.x/api/http.html#class-httpserver) that you still need to call `listen()` on.

### `client.data`

An [`EventEmitter`](https://nodejs.org/docs/latest-v20.x/api/events.html#class-eventemitter) that will emit `${service}:${rootSubTag}`, where `service` & `rootSubTag` depend on the service that you subscribe on.

> [!NOTE]
> The arguments of the events below, unless otherwise noted, are JSON equivalents of the XML trees sent by the server (see the [*XML to JSON mapping* section](#xml-to-json-mapping)).

#### event `aus:IstFahrt`

Arguments:
1. `istFahrt` – The `AUS` `IstFahrt`.

#### event `raw:dfi:AZBNachricht`

Arguments:
1. `azbNachricht` – The whole `DFI` `AZBNachricht`, usually containing many `AZBFahrplanlage`s, `AZBFahrtLoeschen`s, etc.

#### event `raw:aus:AUSNachricht`

Arguments:
1. `ausNachricht` – The whole `AUS` `AUSNachricht`, usually containing many `IstFahrt`s.

### `client.dfiSubscribe()`

`dfiSubscribe(azbId, opt = {})` is an async function that takes the following arguments:

1. `azbId`: The ID of a `DFI` *Anzeigerbereich*, a.k.a. a stop or station.
2. `opt` (optional): An object whose fields override the following defaults:
	- `expiresAt`: `Date.now() + DFI_DEFAULT_SUBSCRIPTION_TTL`,
	- `linienId`: `null`,
	- `richtungsId`: `null`,
	- `vorschauzeit`: `10` (in minutes)
	- `hysterese`: `1` (in seconds)
	- `fetchInterval`: `30_000` (in milliseconds)

After subscribing successfully, it will return an object with the following fields:

- `aboId`: The ID that represents the subscription. It can be used to unsubscribe.

### `client.dfiFetchData()`

`dfiFetchData(opt = {})` is an async function that takes the following arguments:

1. `opt` (optional): An object whose fields override the following defaults:
	- `abortController`: *inactive `AbortController`* – Pass in your own to be able to [`.abort()`](https://nodejs.org/docs/latest-v20.x/api/globals.html#abortcontrollerabortreason) the fetching.

### `client.dfiUnsubscribe()`

`dfiUnsubscribe(...aboIds)` is an async function that takes the following arguments:

1. `aboIds`: >0 subscription IDs.

### `client.dfiUnsubscribeAll()`

`dfiUnsubscribeAll()` is an async function that 0 arguments. It unsubscribes from all active `DFI` subscriptions the server knows about.

### `client.dfiCheckServerStatus()`

Sends a VDV-453 `StatusAnfrage` to the server, to obtain information about the server's state related to the `DFI` service.

`dfiCheckServerStatus()` is an async function that returns an object with the following fields:

- `datenBereit` (boolean): If the server has new `DFI` data to be fetched by the client.
- `startDienstZst` (ISO 8601 string or `null`): When the server's `DFI` service has been started.
- `statusAntwort` (object): The whole response's `StatusAntwort` element.

### `client.ausSubscribe()`

`ausSubscribe(opt = {})` is an async function that takes the following arguments:

1. `opt` (optional): An object whose fields override the following defaults:
	- `expiresAt`: `Date.now() + AUS_DEFAULT_SUBSCRIPTION_TTL`,
	- `vorschauzeit`: `10` (in minutes)
	- `hysterese`: `60` (in seconds)
	- `fetchInterval`: `30_000` (in milliseconds)

After subscribing successfully, it will return an object with the following fields:

- `aboId`: The ID that represents the subscription. It can be used to unsubscribe.

### `client.ausFetchData()`

Works like `client.dfiFetchData()`, except for `AUS`.

### `client.ausUnsubscribe()`

Works like `client.dfiUnsubscribe()`, except for `AUS`.

### `client.ausUnsubscribeAll()`

Works like `client.dfiUnsubscribeAll()`, except for `AUS`.

### `client.ausCheckServerStatus()`

Works like `client.dfiCheckServerStatus()`, except for `AUS`.

### `client.unsubscribeAllOwned()`

An async function that will unsubscribe from all (unexpired) subscriptions created using `client`.

### error handling

The functions in `client` may reject with the following errors:
- `Vdv453HttpError` – The server has rejected the client's HTTP request, e.g. because it is malformed, or because the server is overloaded.
- `Vdv453ApiError` – The server has accepted the client's HTTP request but signaled that it couldn't process it, e.g. because a subscription filter is not valid.
- `Error` – A generic error thrown in some cases.

### XML to JSON mapping

`vdv-453-client` uses [`xml-stream-saxes`](https://npmjs.com/package/xml-stream-saxes) to parse XML into JavaScript/JSON trees.

For example, the following (simplified) XML `IstFahrt`:

```xml
<IstFahrt Zst="2024-04-11T09:10:11Z">
	<LinienID>M8</LinienID>
	<Komplettfahrt>false</Komplettfahrt>
	<IstHalt>
		<HaltID>ODEG_900170006</HaltID>
		<Abfahrtszeit>2024-04-11T11:52:00Z</Abfahrtszeit>
	</IstHalt>
	<IstHalt>
		<HaltID>ODEG_900171517</HaltID>
		<Abfahrtszeit>2024-04-11T12:07:00Z</Abfahrtszeit>
	</IstHalt>
</IstFahrt>
```

into the following JSON tree.

```js
{
	'$name': 'IstFahrt',
	'$': {
		Zst: '2024-04-11T09:10:11Z',
	},
	'$children': [
		{
			'$name': 'LinienID',
			'$text': 'M8',
			'$children': ['M8'],
		},
		{
			'$name': 'Komplettfahrt',
			'$text': 'false',
			'$children': ['false'],
		},
		{
			'$name': 'IstHalt',
			'$children': [
				{
					'$name': 'HaltID',
					'$text': 'ODEG_900170006',
					'$children': ['ODEG_900170006'],
				},
				{
					'$name': 'Abfahrtszeit',
					'$text': '2024-04-11T11:52:00Z',
					'$children': ['2024-04-11T11:52:00Z'],
				}
			],
			HaltID: {
				'$name': 'HaltID',
				'$text': 'ODEG_900170006',
				'$children': ['ODEG_900170006'],
			},
			Abfahrtszeit: {
				'$name': 'Abfahrtszeit',
				'$text': '2024-04-11T11:52:00Z',
				'$children': ['2024-04-11T11:52:00Z'],
			},
		},
		{
			'$name': 'IstHalt',
			'$children': [
				{
					'$name': 'HaltID',
					'$text': 'ODEG_900171517',
					'$children': ['ODEG_900171517'],
				},
				{
					'$name': 'Abfahrtszeit',
					'$text': '2024-04-11T12:07:00Z',
					'$children': ['2024-04-11T12:07:00Z'],
				}
			],
			HaltID: {
				'$name': 'HaltID',
				'$text': 'ODEG_900171517',
				'$children': ['ODEG_900171517'],
			},
			Abfahrtszeit: {
				'$name': 'Abfahrtszeit',
				'$text': '2024-04-11T12:07:00Z',
				'$children': ['2024-04-11T12:07:00Z'],
			},
		}
	],
	LinienID: {
		'$name': 'LinienID',
		'$text': 'M8',
		'$children': ['M8'],
	},
	Komplettfahrt: {
		'$name': 'Komplettfahrt',
		'$text': 'false',
		'$children': ['false'],
	},
	IstHalt: {
		'$name': 'IstHalt',,
		'$children': [
			{
				'$name': 'HaltID',
				'$text': 'ODEG_900171517',
				'$children': ['ODEG_900171517'],
			},
			{
				'$name': 'Abfahrtszeit',
				'$text': '2024-04-11T12:07:00Z',
				'$children': ['2024-04-11T12:07:00Z'],
			}
		],
		HaltID: {
			'$name': 'HaltID',
			'$text': 'ODEG_900171517',
			'$children': ['ODEG_900171517'],
		},
		Abfahrtszeit: {
			'$name': 'Abfahrtszeit',
			'$text': '2024-04-11T12:07:00Z',
			'$children': ['2024-04-11T12:07:00Z'],
		},
	},
}
```

> [!WARNING] Among all children of a node, the last of each kind (`$name`) will also be exposed on the node as `node[child.$name]` (e.g. `LinienID` above).
> Because you usually can't predict the number of children in a node for sure (nor the order), we recommend to always iterate over `$children` and only use the "direct" named properties if you know what you're doing.

### hooks

`createClient()`'s `opt` object allows you to define the following hooks. A hook can be a sync or an [async](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function) function.

> ![IMPORTANT]
> Your hook functions must never throw/reject, otherwise the client may be subtly broken!

- `onDatenBereitAnfrage`: a function with the signature `async (service, datenBereitAnfrage) => {}`
- `onClientStatusAnfrage`: a function with the signature `async (service, clientStatusAnfrage) => {}`
- `onStatusAntwort`: a function with the signature `async (service, statusAntwort) => {}`
- `onSubscribed`: a function with the signature `async (service, {aboId, aboSubTag, aboSubChildren}, bestaetigung, subStats) => {}`
- `onSubscriptionExpired`: a function with the signature `async (service, {aboId, aboSubTag, aboSubChildren}, subStats) => {}`
- `onSubscriptionCanceled`: a function with the signature `async (service, {aboId, aboSubTag, aboSubChildren}, reason, subStats) => {}`
- `onSubscriptionsResetByServer`: a function with the signature `async (service, subStats) => {}`
- `onSubscriptionManualFetchStarted`: a function with the signature `async (service, {aboId, aboSubTag, aboSubChildren}) => {}`
- `onSubscriptionManualFetchSucceeded`: a function with the signature `async (service, {aboId, aboSubTag, aboSubChildren}, {timePassed}) => {}`
- `onSubscriptionManualFetchFailed`: a function with the signature `async (service, {aboId, aboSubTag, aboSubChildren}) => {}`
- `onDatenAbrufenAntwort`: a function with the signature `async (service, {datensatzAlle, weitereDaten, itLevel, bestaetigung}) => {}`
- `onDataFetchStarted`: a function with the signature `async (service, {datensatzAlle}) => {}`
- `onDataFetchSucceeded`: a function with the signature `async (service, {datensatzAlle}, {nrOfFetches, timePassed}) => {}`
- `onDataFetchFailed`: a function with the signature `async (service, {datensatzAlle}, err, {nrOfFetches, timePassed}) => {}`
- `onAusFetchStarted`: a function with the signature `async ({datensatzAlle}) => {}`
- `onAusFetchSucceeded`: a function with the signature `async ({datensatzAlle}, {nrOfIstFahrts}) => {}`
- `onAusFetchFailed`: a function with the signature `async ({datensatzAlle}, err, {nrOfIstFahrts}) => {}`


## Related

- [vdv-453-nats-adapter](https://github.com/OpenDataVBB/vdv-453-nats-adapter) – Send events from a VDV-453/VDV-454 endpoint to NATS (JetStream).


## Contributing

If you have a question or need support using `vdv-453-client`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, use [the issues page](https://github.com/OpenDataVBB/vdv-453-client/issues).
