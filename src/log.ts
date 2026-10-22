/** 標準エラーへ日本語ログを出す最小ロガー。秘密情報は呼び出し側で渡さない。 */
let verbose = false;

export function setVerbose(on: boolean): void {
  verbose = on;
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function debug(message: string): void {
  if (verbose) process.stderr.write(`  · ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`⚠ ${message}\n`);
}

export function fail(message: string): never {
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
}
