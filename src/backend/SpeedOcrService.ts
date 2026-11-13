import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { SpeedOcrWord } from '../shared/speedOcr'

export class SpeedOcrService {
  private busy = false
  private lastStarted = 0
  private completedReads = 0
  private lastDurationMs: number | null = null
  private readonly command = process.env.ROUND_CARPLAY_OCR_BIN || (process.platform === 'darwin'
    ? '/opt/homebrew/bin/tesseract' : '/usr/bin/tesseract')

  getStatus() {
    return { engine: 'tesseract', available: existsSync(this.command), completedReads: this.completedReads, lastDurationMs: this.lastDurationMs }
  }

  async recognize(png: Buffer): Promise<{ engine: string; words: SpeedOcrWord[] }> {
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Expected PNG')
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    if (!width || !height || width > 1024 || height > 1024) throw new Error('OCR image dimensions exceed limit')
    if (!existsSync(this.command)) throw new Error('Local OCR engine is unavailable')
    if (this.busy || Date.now() - this.lastStarted < 200) throw new Error('OCR is busy')
    this.busy = true
    this.lastStarted = Date.now()
    try {
      const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(this.command, ['stdin', 'stdout', '-l', 'eng', '--psm', '6', 'tsv'], {
          stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_THREAD_LIMIT: '1' }
        })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('OCR timed out')) }, 3000)
        child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 128_000) child.kill() })
        child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString() })
        child.on('error', error => { clearTimeout(timer); reject(error) })
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolveOutput(stdout) : reject(new Error(stderr || 'OCR failed')) })
        child.stdin.on('error', () => undefined)
        child.stdin.end(png)
      })
      const words: SpeedOcrWord[] = output.trim().split('\n').slice(1).flatMap(line => {
        const c = line.split('\t')
        if (c[0] !== '5' || !c[11]?.trim() || Number(c[10]) < 0) return []
        return [{ text: c[11].trim(), confidence: Number(c[10]) / 100,
          x: Number(c[6]) / width, y: Number(c[7]) / height, width: Number(c[8]) / width, height: Number(c[9]) / height }]
      })
      this.completedReads++
      this.lastDurationMs = Date.now() - this.lastStarted
      return { engine: 'tesseract', words }
    } finally { this.busy = false }
  }
}
