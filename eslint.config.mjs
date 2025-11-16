import js from '@eslint/js'
import globals from 'globals'

export default [
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2023,
			globals: globals.node,
		},
		rules: {
			'no-unused-vars': [
				'warn',
				{
					vars: 'all',
					args: 'none',
					ignoreRestSiblings: false,
				},
			],
		},
	},
]
