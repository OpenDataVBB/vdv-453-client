import {
	kBestaetigungZst,
} from './symbols.js'

// todo: find a less homegrown way to do this. is there a way to get xml-stream-saxes to emit our desired format right away?
const parseAusIstFahrt = (istFahrt, ctx) => {
	const {
		zst, // Bestaetigung's Zst attribute
	} = ctx

	const result = {
		Zst: istFahrt.$?.Zst || null,
		LinienID: istFahrt.LinienID?.$text || null,
		LinienText: istFahrt.LinienText?.$text || null,
		RichtungsID: istFahrt.RichtungsID?.$text || null,
		RichtungsText: istFahrt.RichtungsText?.$text || null,
		// todo [breaking]: don't unnest FahrtRef
		FahrtID: istFahrt.FahrtRef?.FahrtID ? {
			FahrtBezeichner: istFahrt.FahrtRef?.FahrtID?.FahrtBezeichner?.$text || null,
			Betriebstag: istFahrt.FahrtRef?.FahrtID?.Betriebstag?.$text || null,
		} : null,
		FahrtStartEnde: istFahrt.FahrtRef?.FahrtStartEnde ? {
			StartHaltID: istFahrt.FahrtRef?.StartHaltID?.$text || null,
			Startzeit: istFahrt.FahrtRef?.Startzeit?.$text || null,
			EndHaltID: istFahrt.FahrtRef?.EndHaltID?.$text || null,
			Endzeit: istFahrt.FahrtRef?.Endzeit?.$text || null,
		} : null,
		// todo [breaking]: parse as boolean?
		Komplettfahrt: istFahrt.Komplettfahrt?.$text || null,
		UmlaufID: istFahrt.UmlaufID?.$text || null,
		// todo [breaking]: parse as boolean?
		PrognoseMoeglich: istFahrt.PrognoseMoeglich?.$text || null,
		// todo [breaking]: parse as boolean?
		FaelltAus: istFahrt.FaelltAus?.$text || null,
		FahrzeugTypID: istFahrt.FahrzeugTypID?.$text || null,
		ServiceAttributs: istFahrt.ServiceAttribut
			? istFahrt.ServiceAttribut.$children.map(sA => [sA.$name, sA.$text])
			: [],
		IstHalts: istFahrt.$children
			.filter(c => c.$name === 'IstHalt')
			.map(istHalt => ({
				HaltID: istHalt.HaltID?.$text || null,
				Abfahrtszeit: istHalt.Abfahrtszeit?.$text || null,
				IstAbfahrtPrognose: istHalt.IstAbfahrtPrognose?.$text || null,
				AbfahrtssteigText: istHalt.AbfahrtssteigText?.$text || null,
				// todo [breaking]: parse as boolean?
				Einsteigeverbot: istHalt.Einsteigeverbot?.$text || null,
				Ankunftszeit: istHalt.Ankunftszeit?.$text || null,
				IstAnkunftPrognose: istHalt.IstAnkunftPrognose?.$text || null,
				AnkunftssteigText: istHalt.AnkunftssteigText?.$text || null,
				// todo [breaking]: parse as boolean?
				Aussteigeverbot: istHalt.Aussteigeverbot?.$text || null,
				// todo [breaking]: parse as boolean?
				Durchfahrt: istHalt.Durchfahrt?.$text || null,
				// todo [breaking]: parse as boolean?
				Zusatzhalt: istHalt.Zusatzhalt?.$text || null,
				HinweisText: istHalt.HinweisText?.$text || null,
			})),
	}

	Object.defineProperty(result, kBestaetigungZst, {value: zst})

	return result
}

export {
	parseAusIstFahrt,
}
