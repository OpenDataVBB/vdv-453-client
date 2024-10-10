'use strict'

import {test} from 'tape'
import {readFileSync} from 'node:fs'
import {Readable} from 'node:stream'
import {strictEqual} from 'node:assert'
import {parseTags} from '../lib/xml-parser.js'
import {runClient} from './util.js'

const LEITSTELLE = 'test-client'

const VBB_DDS_AUS_DATENABRUFENANTWORT_2024_04_11 = readFileSync(
	new URL('./vbb-dds-aus-datenabrufenantwort-2024-04-11.xml', import.meta.url).pathname,
)

test('XML parsing works', async (t) => {
	const input = Readable.from(VBB_DDS_AUS_DATENABRUFENANTWORT_2024_04_11)
	const parser = parseTags(input, [
		{tag: 'Bestaetigung', preserve: true},
		{tag: 'WeitereDaten', preserve: true},
		{tag: 'AUSNachricht', preserve: true},
	])

	const els = []
	for await (const el of parser) {
		els.push(el)
	}

	t.equal(els[0].$name, 'Bestaetigung', 'els[0].$name')
	t.equal(els[1].$name, 'WeitereDaten', 'els[1].$name')
	t.equal(els[2].$name, 'AUSNachricht', 'els[2].$name')
	t.equal(els[2].$children.length, 2, 'els[2].children.length')
})

// todo
test.skip('todo', async (t) => {
	const {
		port,
		stop,
	} = await runClient({
		leitstelle: LEITSTELLE,
		endpoint: 'http://localhost:3000/',
	})

	// todo

	await stop()
})
