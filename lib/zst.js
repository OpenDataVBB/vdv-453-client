import {formatUnixTimestampAsIso8601} from './format-iso-8601-timestamp.js'

const getZst = (t = Date.now()) => {
	return formatUnixTimestampAsIso8601(t)
}

export {
	getZst,
}
