'use strict'

import {strictEqual, ok} from 'node:assert'
import {SaxesParser} from 'saxes'
import {pipeline, Transform} from 'node:stream'

// todo: just emit el instead of [el.$name, el]
// todo: move this into a separate lib, publish on npm
const createParser = (shouldParseNode) => {
	let errored = false
	// stack of nodes `{$, $text, $children, ...}
	const nodes = []
	// top of the stack
	let node = null
	const nodesToEmit = new WeakSet()

	const saxesParser = new SaxesParser()
	saxesParser.on('error', (err) => {
		// todo: remove event listeners instead
		errored = true
		parser.destroy(err)
	})

	saxesParser.on('opentag', (tag) => {
		if (errored) return;

		const shouldEmit = shouldParseNode(tag.name, node, nodes)
		// If we're already within a node to be parsed, don't skip it.
		if (nodes.length === 0 && !shouldEmit) return;

		const child = {
			$name: tag.name,
			$: tag.attributes,
			$text: '',
			$children: [],
		}
		if (node !== null) {
			node.$children.push(child)
			if (tag.name[0] !== '$') {
				node[tag.name] = child
			}
		}
		nodes.push(child)
		node = child
		if (shouldEmit) {
			nodesToEmit.add(child)
		}
	})
	saxesParser.on('text', (text) => {
		if (errored || node === null) return;
		text = text.trim()
		if (text.length > 0) {
			node.$text += text
		}
	})
	saxesParser.on('closetag', (tag) => {
		if (errored || node === null) return;
		nodes.pop()
		const el = node
		node = nodes.length > 0 ? nodes[nodes.length - 1] : null

		if (nodesToEmit.has(el)) {
			parser.push([el.$name, el])
		}
	})
	saxesParser.on('end', () => {
		if (errored) return;
		parser.push(null) // signal EOF
	})

	const parser = new Transform({
		readableObjectMode: true,
		writableObjectMode: false,
		transform: (chunk, encoding, cb) => {
			saxesParser.write(chunk)
			cb()
		},
		flush: (cb) => {
			saxesParser.close()
		},
	})
	return parser
}

// todo: change `tagsToParse` to be just a `Set` of strings
const parseTags = (inputStream, tagsToParse) => {
	tagsToParse = new Set(tagsToParse.map(({tag, preserve}, i) => {
		strictEqual(typeof tag, 'string', `tagsToParse[${i}].tag must be a string`)
		ok(tag, `tagsToParse[${i}].tag must not be empty`)
		return tag
	}))
	const shouldParseNode = (tag) => {
		return tagsToParse.has(tag)
	}

	const parser = createParser(shouldParseNode)
	pipeline(
		inputStream,
		parser,
		(err) => {}, // ignore, as the parser will be destroyed by pipeline()
	)
	return parser
}

export {
	parseTags,
}
