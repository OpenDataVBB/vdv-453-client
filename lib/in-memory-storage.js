'use strict'

const SECOND = 1000
const MINUTE = 60 * SECOND

const openInMemoryStorage = async () => {
	const _storage = new Map()
	const _expiresAt = new Map()

	const garbageCollection = setInterval(() => {
		keys()
	}, MINUTE)
	garbageCollection.unref()

	const has = async (key) => {
		return _storage.has(key)
	}

	const get = async (key) => {
		if (!_storage.has(key)) return null
		const expiresAt = _expiresAt.get(key)
		if (expiresAt <= Date.now()) {
			_storage.delete(key)
			_expiresAt.delete(key)
		}
		return _storage.get(key)
	}

	const set = async (key, val, expiresInMs = Infinity) => {
		const expiresAt = Date.now() + expiresInMs
		_storage.set(key, val)
		_expiresAt.set(key, expiresAt)
	}

	const del = async (key) => {
		_storage.delete(key)
		_expiresAt.delete(key)
	}

	const entries = async (prefix = null) => {
		const now = Date.now()
		let _entries = Array.from(_storage.entries())
		if (prefix) {
			_entries = _entries.filter(([key]) => key.startsWith(prefix))
		}
		const _ = _entries
		.filter(([key]) => {
			if (_expiresAt.get(key) <= now) {
				_storage.delete(key)
				_expiresAt.delete(key)
				return false
			}
			return true
		})
		return _
	}

	const keys = async (prefix = null) => {
		return (await entries(prefix)).map(([key]) => key)
	}

	return {
		has,
		get,
		set,
		del,
		keys,
		entries,
	}
}

export {
	openInMemoryStorage,
}
