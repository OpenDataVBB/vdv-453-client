// selected from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects#error_objects
const PROGRAMMER_ERRORS = [
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
]
const isProgrammerError = (err) => {
	// todo: use `PROGRAMMER_ERRORS.includes(err.__proto__.constructor)`?
	return PROGRAMMER_ERRORS.some(Err => err instanceof Err)
}

export {
	isProgrammerError,
}
