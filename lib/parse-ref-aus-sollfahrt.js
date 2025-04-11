import {
	kBestaetigungZst,
} from './symbols.js'

const PARSED_LINIENFAHRPLAN_CHILDREN = new Set([
	'SollFahrt',
	'LinienID',
	'RichtungsID',
	'ProduktID',
	'BetreiberID',
	'LinienText',
	'RichtungsText',
	'VonRichtungsText',
	'VerkehrsmittelText',
	'PrognoseMoeglich',
	'Fahrradmitnahme',
])

// todo: find a less homegrown way to do this. is there a way to get xml-stream-saxes to emit our desired format right away?
const parseRefAusSollFahrt = (sollFahrt, linienfahrplan, ctx) => {
	const {
		zst, // Bestaetigung's Zst attribute
	} = ctx

	const result = {
		Zst: sollFahrt.$?.Zst || null,

		// Linienfahrplan properties
		LinienID: linienfahrplan.LinienID?.$text || null,
		RichtungsID: linienfahrplan.RichtungsID?.$text || null,
		// todo: expose deprecated Linienfahrplan.FahrplanVersionID?
		ProduktID: linienfahrplan.ProduktID?.$text || null,
		BetreiberID: linienfahrplan.BetreiberID?.$text || null,

		// Linienfahrplan & SollFahrt properties
		// todo: does it make sense to conflate them?
		LinienText: sollFahrt.LinienText?.$text || linienfahrplan.LinienText?.$text || null,
		RichtungsText: sollFahrt.RichtungsText?.$text || linienfahrplan.RichtungsText?.$text || null,
		VonRichtungsText: sollFahrt.VonRichtungsText?.$text || linienfahrplan.VonRichtungsText?.$text || null,
		VerkehrsmittelText: sollFahrt.VerkehrsmittelText?.$text || linienfahrplan.VerkehrsmittelText?.$text || null,
		// todo [breaking]: parse as boolean?
		PrognoseMoeglich: sollFahrt.PrognoseMoeglich?.$text || linienfahrplan.PrognoseMoeglich?.$text || null,
		// todo [breaking]: parse as boolean?
		Fahrradmitnahme: sollFahrt.Fahrradmitnahme?.$text || linienfahrplan.Fahrradmitnahme?.$text || null,
		// todo: parse n HinweisText children

		// SollFahrt properties
		FahrtID: sollFahrt.FahrtID ? {
			FahrtBezeichner: sollFahrt.FahrtID?.FahrtBezeichner?.$text || null,
			Betriebstag: sollFahrt.FahrtID?.Betriebstag?.$text || null,
		} : null,
		UmlaufID: sollFahrt.UmlaufID?.$text || null,
		LinienfahrwegID: sollFahrt.LinienfahrwegID?.$text || null,
		Zugname: sollFahrt.Zugname?.$text || null,
		// todo [breaking]: parse as boolean?
		Zusatzfahrt: sollFahrt.Zusatzfahrt?.$text || null,
		// todo [breaking]: parse as boolean?
		FaelltAus: sollFahrt.FaelltAus?.$text || null,
		FahrzeugTypID: sollFahrt.FahrzeugTypID?.$text || null,
		ServiceAttributs: sollFahrt.ServiceAttribut
			? sollFahrt.ServiceAttribut.$children.map(sA => [sA.$name, sA.$text])
			: [],

		SollHalts: sollFahrt.$children
			.filter(c => c.$name === 'SollHalt')
			.map(sollHalt => ({
				HaltID: sollHalt.HaltID?.$text || null,
				HaltestellenName: sollHalt.HaltestellenName?.$text || null,
				Abfahrtszeit: sollHalt.Abfahrtszeit?.$text || null,
				AbfahrtssteigText: sollHalt.AbfahrtssteigText?.$text || null,
				// todo [breaking]: parse as boolean?
				Einsteigeverbot: sollHalt.Einsteigeverbot?.$text || null,
				Ankunftszeit: sollHalt.Ankunftszeit?.$text || null,
				AnkunftssteigText: sollHalt.AnkunftssteigText?.$text || null,
				// todo [breaking]: parse as boolean?
				Aussteigeverbot: sollHalt.Aussteigeverbot?.$text || null,
				// todo [breaking]: parse as boolean?
				Durchfahrt: sollHalt.Durchfahrt?.$text || null,
				RichtungsText: sollHalt.RichtungsText?.$text || null,
				VonText: sollHalt.VonText?.$text || null,
				LinienfahrwegID: sollFahrt.LinienfahrwegID?.$text || null,
				// todo: parse n HinweisText children
				// todo: parse n SollAnschluss children
			})),

		// todo: parse n SollFormation children
	}

	Object.defineProperty(result, kBestaetigungZst, {value: zst})

	return result
}

export {
	PARSED_LINIENFAHRPLAN_CHILDREN,
	parseRefAusSollFahrt,
}
