'use strict'

const defer = () => {
	let resolve, reject
	const promise = new Promise((_resolve, _reject) => {
		resolve = _resolve
		reject = _reject
	})
	return {promise, resolve, reject}
}

const createAsyncIterableWithPush = () => {
	const items = []
	let error = null
	let empty = defer()
	let isDone = false

	const asyncIterator = {
		next: async () => {
			if (error !== null) throw error
			if (items.length === 0) {
				if (isDone) return {done: true, value: undefined}
				await empty.promise
			}
			return {
				done: false,
				value: items.shift(),
			}
		},
	}

	let iterators = 0
	const asyncIterable = {
		[Symbol.asyncIterator]: () => {
			if (++iterators > 1) {
				throw new Error('this async iterable only supports *one* iterator')
			}
			return asyncIterator
		},
	}

	const push = (item) => {
		items.push(item)

		if (items.length === 1) {
			empty.resolve()
			empty = defer()
		}
	}

	const fail = (err) => {
		error = err
		empty.reject(err)
	}

	const done = () => {
		isDone = true
	}
	return {
		asyncIterable,
		push,
		fail,
		done,
	}
}

// todo: remove
// const {push, fail, done, asyncIterable} = createAsyncIterableWithPush()
// push(1)
// push(2)
// setTimeout(push, 1000, 3)
// setTimeout(push, 5000, 4)
// setTimeout(fail, 6000, new Error('foo'))
// setTimeout(push, 7000, 5)
// setTimeout(done, 7001)
// ;(async () => {
// 	for await (const v of asyncIterable) console.log(v)
// })()
// .catch(() => {})
// obtaining two iterators must fail!
// ;(async () => {
// 	for await (const v of asyncIterable) console.log(v)
// })()

export {
	createAsyncIterableWithPush,
}
