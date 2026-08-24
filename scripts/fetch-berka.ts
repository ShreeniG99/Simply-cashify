/**
 * Downloads the real Berka / PKDD'99 dataset (~67MB) to `data/raw/berka/`.
 * Not committed to the repo — `data/raw/` is gitignored.
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import path from 'node:path'

const DIR = path.join(process.cwd(), 'data/raw/berka')
const BASE = 'https://raw.githubusercontent.com/jlacko/berka-dataset/master'
const FILES = ['order.asc', 'trans.asc']

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  await mkdir(DIR, { recursive: true })

  for (const file of FILES) {
    const dest = path.join(DIR, file)
    if (await exists(dest)) {
      console.log(`  ${file} already present, skipping`)
      continue
    }
    console.log(`  downloading ${file}...`)
    const res = await fetch(`${BASE}/${file}`)
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buf)
    console.log(`  -> ${file}  ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
  }

  console.log('\nDone. Run `npm run bench:berka` next.')
}

main().catch((err) => {
  console.error('fetch:berka failed:', err.message)
  process.exit(1)
})
