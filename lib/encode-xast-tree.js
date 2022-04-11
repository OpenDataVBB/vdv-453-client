'use strict'

import {toXml} from 'xast-util-to-xml'

const encodeXastTree = (xastTree) => {
	return toXml(xastTree)
}

export {
	encodeXastTree,
}
