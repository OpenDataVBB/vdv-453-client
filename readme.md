# vdv-453-client

**A client for [VDV-453 v2.3.2b](https://web.archive.org/web/20231208122259/https://www.vdv.de/453v2.3.2-sds.pdf.pdfx?forced=false)/[VDV-454 v1.2.2](https://web.archive.org/web/20231208122259/https://www.vdv.de/454v1.2.2-sds.pdf.pdfx?forced=false) (from 2013) client.** Can be used to connect to German public transport realtime data backends (*Datendrehscheiben*).

*Note:* This client supports neither the latest 2.x spec versions ([VDV-453 v2.6.1](https://www.vdv.de/vdv-schrift-453-v2.6.1-de.pdfx?forced=true)/[VDV-454 v2.2.1](https://www.vdv.de/454v2.2.1-sd.pdfx?forced=true)) nor the latest 3.x spec versions ([VDV-453 v3.0](https://www.vdv.de/downloads/4337/453v3.0%20SDS/forced)/[VDV-454 v3.0](https://www.vdv.de/downloads/4336/454v3.0%20SDS/forced)).

[![npm version](https://img.shields.io/npm/v/vdv-453-client.svg)](https://www.npmjs.com/package/vdv-453-client)
![ISC-licensed](https://img.shields.io/github/license/derhuerst/vdv-453-client.svg)
![minimum Node.js version](https://img.shields.io/node/v/vdv-453-client.svg)
[![chat with me on Twitter](https://img.shields.io/badge/chat%20with%20me-on%20Twitter-1da1f2.svg)](https://twitter.com/derhuerst)


## Installation

```shell
npm install derhuerst/vdv-453-client
```


## Usage

With the organisation providing the VDV 453 API, you will have to agree upon a *Leitstellenkennung*, which is a bit like an HTTP User-Agent:

> 6.1.3 Leitstellenkennung
> Um Botschaften verschiedener Kommunikationspartner innerhalb eines Dienstes unterscheiden zu können, enthält jede Nachricht eine eindeutige Leitstellenkennung (Attribut Sender) des nachfragenden Systems. […]

```js
const LEITSTELLE = '…'
```

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
	endpoint: '…', // HTTP(s) URL
})

// start HTTP server
await new Promise((resolve, reject) => {
	httpServer.listen(3000, (err) => {
		if (err) reject(err)
		else resolve()
	})
})

// subscribe to VDV-453 DFI service
const {aboId: dfiAboId} = await dfiSubscribe()
data.on('dfi:AZBNachricht', (azbNachricht) => console.log(azbNachricht))

// subscribe to VDV-454 AUS service
const {aboId: ausAboId} = await ausSubscribe()
data.on('aus:IstFahrt', (istFahrt) => console.log(istFahrt))

process.once('SIGINT', {
	Promise.all([
		dfiUnsubscribe(dfiAboId),
		ausUnsubscribe(ausAboId),
	])
	.then(() => {
		httpServer.close()
	})
	.catch(abortWithError)
})
```


## Contributing

If you have a question or need support using `vdv-453-client`, please double-check your code and setup first. If you think you have found a bug or want to propose a feature, use [the issues page](https://github.com/derhuerst/vdv-453-client/issues).
