'use strict'

import {strictEqual, ok} from 'node:assert'
import XmlParser from 'xml-stream-saxes'
import {
	createAsyncIterableWithPush as asyncItWithPush,
} from './async-iterable-with-push.js'

const createXmlParser = (input) => {
	const parser = new XmlParser(input)
	parser.once('error', (err) => {
		input.destroy(err)
		parser.pause()
	})

	return parser
}

const parseTags = (inputStream, tagsToParse) => {
	const {
		asyncIterable: parsed,
		push,
		fail,
		done,
	} = asyncItWithPush()

	// todo: stop parsing if `parsed` is not being iterated anymore
	const parser = createXmlParser(inputStream)
	parser.once('error', fail)
	parser.once('end', done)

	tagsToParse.forEach(({tag, preserve}, i) => {
		strictEqual(typeof tag, 'string', `tagsToParse[${i}].tag must be a string`)
		ok(tag, `tagsToParse[${i}].tag must not be empty`)
		strictEqual(typeof preserve, 'boolean', `tagsToParse[${i}].preserve must be a boolean`)

		parser.collect(tag)
		if (preserve) parser.preserve(tag)

		// todo: try/catch?
		parser.on('endElement: ' + tag, el => push([tag, el]))
	})

	return parsed
}

export {
	createXmlParser,
	parseTags,
}
