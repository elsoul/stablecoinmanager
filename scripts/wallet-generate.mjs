#!/usr/bin/env node
// secret-pipe contract: stdout carries ONLY the phrase. Everything else goes to stderr.
// Never write the phrase to a file, argv, or stderr. Do not call wrangler here.
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { mnemonicToAccount } from 'viem/accounts'

const mnemonic = generateMnemonic(wordlist, 256)
const evm = mnemonicToAccount(mnemonic, { path: "m/44'/60'/0'/0/0" }).address
process.stderr.write(`EVM address (Ethereum / Base / Avalanche C): ${evm}\n`)
process.stdout.write(mnemonic)
