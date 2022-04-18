'use strict'

import XmlParser from 'xml-stream-saxes'

const createXmlParser = (input) => {
	const parser = new XmlParser(input)
	parser.once('error', (err) => {
		input.destroy(err)
		parser.pause()
	})

	return parser
}

export {
	createXmlParser,
}
