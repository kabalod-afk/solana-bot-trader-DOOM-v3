import TelegramBot from 'node-telegram-bot-api';
import {
  EntryAlertOpts,
  ExitAlertOpts,
  StatusCheckOpts,
  formatEntryAlert,
  formatExitAlert,
  formatStatusCheck,
} from './telegramAlerts';

export class TelegramService {
  private bot: TelegramBot;
  private isPausedFlag = false;
  private onForceCloseCallback?: () => Promise<void>;
  private onHeliosStatus?: () => string;
  private statusCheckSent = false;

  constructor(
    token: string,
    private chatId: string
  ) {
    this.bot = new TelegramBot(token, {
      polling: { interval: 2000, params: { timeout: 30 } },
    });
    this.listenCommands();
  }

  public registerForceCloseHandler(handler: () => Promise<void>): void {
    this.onForceCloseCallback = handler;
  }

  public registerHeliosStatusHandler(handler: () => string): void {
    this.onHeliosStatus = handler;
  }

  /**
   * Escapa & < > y convierte *negrita* / `código` a HTML.
   * Evita el escape agresivo de MarkdownV2 (\( \) \. etc.).
   */
  private toHtml(text: string): string {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped
      .replace(/\*([^*]+)\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  private listenCommands(): void {
    this.bot.on('message', async (msg) => {
      if (msg.chat.id.toString() !== this.chatId || !msg.text) return;
      const text = msg.text.toLowerCase().trim();

      if (
        text.includes('finalizar operacion') ||
        text.includes('orden de finalizar') ||
        text === '/stop'
      ) {
        this.isPausedFlag = true;
        await this.sendText(
          `🛑 *ORDEN RECIBIDA:* Liquidando posiciones activas y pausando el motor...`
        );

        if (this.onForceCloseCallback) {
          await this.onForceCloseCallback();
        }
        await this.sendText(`✅ *POSICIONES LIQUIDADAS Y MOTOR EN PAUSA.*`);
      }

      if (text.includes('reanudar') || text.includes('iniciar operacion')) {
        this.isPausedFlag = false;
        await this.sendText(`🟢 *MOTOR REANUDADO:* Escaneo de nuevos tokens activo.`);
      }

      if (text.includes('estatus') || text.includes('estado')) {
        await this.sendText(
          this.isPausedFlag
            ? `⏸ *ESTADO:* En Pausa.`
            : `🟢 *ESTADO:* Operando activamente.`
        );
      }

      if (
        text === 'helios' ||
        text === '/helios' ||
        text.includes('cerebro') ||
        text.includes('asistencia')
      ) {
        const report = this.onHeliosStatus?.() ?? '🧠 Helios no está enlazado.';
        await this.sendHtml(report);
      }
    });
  }

  public isPaused(): boolean {
    return this.isPausedFlag;
  }

  public async sendText(msg: string): Promise<void> {
    await this.sendHtml(this.toHtml(msg), msg.replace(/[*_`]/g, ''));
  }

  /** HTML ya construido (no re-escapa tags). */
  public async sendHtml(html: string, plainFallback?: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, html, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e1) {
      const msg1 = e1 instanceof Error ? e1.message : String(e1);
      if (/chat not found|bot was blocked|unauthorized/i.test(msg1)) {
        console.error(`[TELEGRAM] ${msg1} — revisa TELEGRAM_CHAT_ID y que hayas abierto el bot.`);
        return;
      }
      try {
        await this.bot.sendMessage(
          this.chatId,
          plainFallback ?? html.replace(/<[^>]+>/g, '')
        );
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        console.error(`[TELEGRAM] ${msg2}`);
      }
    }
  }

  /** 1/3 — una sola vez al arrancar el proceso. */
  public async notifyStatusCheck(opts: StatusCheckOpts): Promise<void> {
    if (this.statusCheckSent) return;
    this.statusCheckSent = true;
    await this.sendHtml(formatStatusCheck(opts));
  }

  /** 2/3 — compra ejecutada (o simulación DRY-RUN tras las 3 fases). */
  public async notifyEntry(opts: EntryAlertOpts): Promise<void> {
    await this.sendHtml(formatEntryAlert(opts));
  }

  /** 3/3 — venta + PnL + ruteo a bóveda. */
  public async notifyExit(opts: ExitAlertOpts): Promise<void> {
    await this.sendHtml(formatExitAlert(opts));
  }
}
