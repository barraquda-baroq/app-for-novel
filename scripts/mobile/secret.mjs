// 秘密のファイル（Android の署名の鍵・android/keystore.properties）を、このパソコンのほかの利用者が読めない形で置く（scripts/mobile.mjs）。
// Mac・Linux は 0600（フォルダは 0700）。Windows では mode は読み取り専用の印にしか効かない（0600 は書ける形なので害はない）。
// scripts/mobile/secret.test.mjs で確かめる
import fs from 'node:fs'
import path from 'node:path'

export const SECRET_FILE_MODE = 0o600
export const SECRET_DIR_MODE = 0o700

/** 秘密を置くフォルダを作る（もうあるフォルダは変えない。中のファイルを 0600 にするので足りる） */
export function makeSecretDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE })
}

/** 自分だけが読み書きできるようにする（keytool の作る鍵は 0644 になる） */
export function protectSecret(file) {
  fs.chmodSync(file, SECRET_FILE_MODE)
}

/** 秘密のファイルを書く（前からあるファイルの形も直す。--use でやり直した時など） */
export function writeSecret(file, text) {
  fs.writeFileSync(file, text, { mode: SECRET_FILE_MODE })
  protectSecret(file)
}

/** 秘密のファイルをコピーする（copyFileSync は元の形を写すので、USB メモリ（exFAT）からだと 0777 になる） */
export function copySecret(src, dest) {
  makeSecretDir(path.dirname(dest))
  fs.copyFileSync(src, dest)
  protectSecret(dest)
}
