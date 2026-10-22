import { createInterface } from "node:readline";

/** 端末で人が操作しているか（CI やパイプでは質問しない） */
export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** 1行聞く。secret=true なら入力を画面に出さない。 */
export function ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (opts.secret) {
      const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      let prompted = false;
      r._writeToOutput = (s: string) => {
        if (!prompted) {
          r.output.write(s);
          prompted = true;
        } else if (s.includes("\n") || s.includes("\r")) {
          r.output.write("\n");
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** はい/いいえ。既定は「いいえ」。 */
export async function confirm(question: string): Promise<boolean> {
  const a = await ask(`${question} [y/N] `);
  return /^(y|yes|はい)$/i.test(a);
}
