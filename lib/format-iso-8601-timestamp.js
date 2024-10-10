'use strict'

import {strictEqual} from 'assert'

// > 6.1.2 Datum- und Zeitformat
// > Jede Zeitinformation bezieht sich auf die sogenannte UTC (Coordinated Universal Time). Abweichungen von dieser Zeitzone werden gemäß ISO 8601 kodiert:
// > Beispiel: 2000-04-07T18:39:00+01:00.
// > Ohne Angabe der zeitlichen Abweichung ist die Zeitangabe bereits in UTC. In diesem Fall kann auch ein abschließendes Z folgen
// > Beispiel: 2002-04-30T12:00:00 entspricht 2002-04-30T12:00:00Z.
// todo: rename to e.g. formatMsUnixTimestampAsIso8601
const formatUnixTimestampAsIso8601 = (t) => {
	strictEqual(typeof t, 'number', 't must be a number')

	// > Es werden keine weiteren Zeiteinheiten jenseits der Sekunde, also 1/10-, 1/100-Sekunden verwendet. Ist dies der Fall, so werden sie beim Import ignoriert.
	t = Math.floor(t / 1000) * 1000
	return new Date(t).toISOString().replace('.000', '')
}

export {
	formatUnixTimestampAsIso8601,
}
