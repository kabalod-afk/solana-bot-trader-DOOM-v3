import os from 'os';

export class MemoryScheduler {
  private activeThreads = 0;
  private nextBotSerial = 1;
  private inflightAudits = 0;
  private readonly MAX_INFLIGHT = 1;

  public canSpawnThread(): boolean {
    const freeRamGB = os.freemem() / (1024 * 1024 * 1024);
    const maxAllowedThreads = Math.max(1, Math.floor(freeRamGB * 2));
    return this.activeThreads < maxAllowedThreads;
  }

  public tryAcquireInflight(): boolean {
    if (this.inflightAudits >= this.MAX_INFLIGHT) return false;
    this.inflightAudits++;
    return true;
  }

  public releaseInflight(): void {
    this.inflightAudits = Math.max(0, this.inflightAudits - 1);
  }

  public getInflightCount(): number {
    return this.inflightAudits;
  }

  public registerThread(): string {
    this.activeThreads++;
    const id = `BOT #${String(this.nextBotSerial).padStart(2, '0')}`;
    this.nextBotSerial++;
    return id;
  }

  public releaseThread(): void {
    this.activeThreads = Math.max(0, this.activeThreads - 1);
  }

  public getActiveThreads(): number {
    return this.activeThreads;
  }
}
