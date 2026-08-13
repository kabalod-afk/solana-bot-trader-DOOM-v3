import TelegramBot from 'node-telegram-bot-api';

export class TelegramService {
  private bot: TelegramBot;
  private isPausedFlag = false;
  private onForceCloseCallback?: () => Promise<void>;
  private onHeliosStatus?: () => string;

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

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private ticker(mint: string, symbol?: string): string {
    if (symbol && symbol.trim()) return this.esc(symbol.trim());
    return this.esc(mint.slice(0, 6));
  }

  public async notifyHelios(html: string): Promise<void> {
    await this.sendHtml(html);
  }

  /** Paso 1: B0 aprobado → radar de incubación (máx 3.5 min). */
  public async notifyRadarEntry(
    mint: string,
    poolSol: number,
    mcUsd: number,
    symbol?: string,
    heliosBrief?: string
  ): Promise<void> {
    const msg =
      `📡 <b>[RADAR B0] Token Aprobado</b>\n\n` +
      `• <b>Token:</b> $${this.ticker(mint, symbol)}\n` +
      `• <b>Mint:</b> <code>${this.esc(mint)}</code>\n` +
      `• <b>Pool Inicial:</b> ${poolSol.toFixed(2)} SOL\n` +
      `• <b>MC Inicial:</b> $${mcUsd.toFixed(0)} USD\n` +
      `• <b>Estado:</b> Radar de incubación (Máx 3.5 min, ≥3 txs + breakout)...` +
      (heliosBrief ? `\n\n${heliosBrief}` : '');
    await this.sendHtml(msg);
  }

  /** Paso 2: compra ejecutada. */
  public async notifyBuyExecuted(
    mint: string,
    currentMc: number,
    txs: number,
    amountSol: number,
    txHash: string,
    symbol?: string
  ): Promise<void> {
    const hash = this.esc(txHash || 'pendiente');
    const link = txHash
      ? `<a href="https://solscan.io/tx/${hash}">Ver en Solscan</a>`
      : 'pendiente';
    const msg =
      `🎯 <b>[BUY TRIGGERED] Breakout Confirmado</b>\n\n` +
      `• <b>Token:</b> $${this.ticker(mint, symbol)}\n` +
      `• <b>MC Actual:</b> $${currentMc.toFixed(0)} USD\n` +
      `• <b>Confirmaciones:</b> ${txs} txs\n` +
      `• <b>Monto Entrada:</b> ${amountSol} SOL\n` +
      `• <b>Tx:</b> ${link}`;
    await this.sendHtml(msg);
  }

  /** Paso 3: venta + informe PnL + SOL que vuelve a Cartera A. */
  public async notifyTradeClosed(
    mint: string,
    reason: string,
    pnlSol: number,
    pnlPercent: number,
    durationSec: number,
    txHash: string,
    symbol?: string,
    vaultB?: string,
    vaultedSol?: number,
    walletAReturnedSol?: number,
    walletABalanceSol?: number
  ): Promise<void> {
    const icon = pnlSol >= 0 ? '🟢' : '🔴';
    const hash = this.esc(txHash || '');
    const link = txHash
      ? `<a href="https://solscan.io/tx/${hash}">Ver en Solscan</a>`
      : 'n/d';
    const vaultLine =
      vaultB && (vaultedSol ?? 0) > 0
        ? `\n• <b>Ruteo a Cartera B:</b> +${(vaultedSol ?? 0).toFixed(3)} SOL → <code>${this.esc(vaultB)}</code>`
        : vaultB && pnlSol > 0
          ? `\n• <b>Cartera B (vault):</b> <code>${this.esc(vaultB)}</code> (PnL no ruteado: dry-run o sin saldo)`
          : vaultB
            ? `\n• <b>Cartera B (vault):</b> <code>${this.esc(vaultB)}</code> (sin superávit)`
            : '';
    const walletALine =
      walletAReturnedSol !== undefined || walletABalanceSol !== undefined
        ? `\n• <b>Vuelto a Cartera A:</b> ${
            walletAReturnedSol !== undefined
              ? `${walletAReturnedSol >= 0 ? '+' : ''}${walletAReturnedSol.toFixed(4)} SOL (Δ venta)`
              : 'n/d'
          }` +
          (walletABalanceSol !== undefined
            ? `\n• <b>Saldo Cartera A ahora:</b> ${walletABalanceSol.toFixed(4)} SOL`
            : '')
        : '';
    const msg =
      `🏁 <b>[TRADE CLOSED] Operación Finalizada</b>\n\n` +
      `• <b>Token:</b> $${this.ticker(mint, symbol)}\n` +
      `• <b>Motivo Cierre:</b> ${this.esc(reason)}\n\n` +
      `<b>📊 Informe de Operación:</b>\n` +
      `├─ <b>Tiempo Transcurrido:</b> ${durationSec}s\n` +
      `└─ <b>PnL Neto:</b> ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(3)} SOL (${pnlPercent.toFixed(1)}%) ${icon}\n\n` +
      `• <b>Tx Venta:</b> ${link}` +
      walletALine +
      vaultLine;
    await this.sendHtml(msg);
  }

  /** Compra fallida (sin posición abierta). */
  public async notifyBuyFailed(
    mint: string,
    amountSol: number,
    walletABalanceSol: number,
    detail?: string
  ): Promise<void> {
    const msg =
      `⚠️ <b>[BUY FAILED] Compra no confirmada</b>\n\n` +
      `• <b>Token:</b> $${this.ticker(mint)}\n` +
      `• <b>Intentado:</b> ${amountSol.toFixed(2)} SOL\n` +
      `• <b>Saldo Cartera A:</b> ${walletABalanceSol.toFixed(4)} SOL` +
      (detail ? `\n• <b>Detalle:</b> ${this.esc(detail)}` : '');
    await this.sendHtml(msg);
  }

  /** Evacuación tras compra si el precio on-chain sale en 0. */
  public async notifyEntryAbort(
    mint: string,
    investedSol: number,
    sellOk: boolean,
    txHash: string,
    walletAReturnedSol: number,
    walletABalanceSol: number
  ): Promise<void> {
    const link = txHash
      ? `<a href="https://solscan.io/tx/${this.esc(txHash)}">Ver en Solscan</a>`
      : 'n/d';
    const msg =
      `🧯 <b>[ENTRY ABORT] Evacuación post-compra</b>\n\n` +
      `• <b>Token:</b> $${this.ticker(mint)}\n` +
      `• <b>Motivo:</b> precio on-chain 0 tras compra\n` +
      `• <b>Invertido:</b> ~${investedSol.toFixed(2)} SOL\n` +
      `• <b>Venta:</b> ${sellOk ? 'OK' : 'FALLÓ — revisa tokens en A'}\n` +
      `• <b>Vuelto a Cartera A:</b> ${walletAReturnedSol >= 0 ? '+' : ''}${walletAReturnedSol.toFixed(4)} SOL (Δ)\n` +
      `• <b>Saldo Cartera A ahora:</b> ${walletABalanceSol.toFixed(4)} SOL\n` +
      `• <b>Tx:</b> ${link}`;
    await this.sendHtml(msg);
  }

  /**
   * Silenciado: rechazos B0 no van a Telegram (solo consola/PM2).
   * Conservamos alertas de análisis aprobado, compra y venta/PnL.
   */
  public async notifyBlockZeroReject(_token: string, _reason: string): Promise<void> {
    return;
  }

  /** Alias: token superó B0 y entra a ventana dinámica. */
  notifyAnalysisPassed(
    _botId: string,
    token: string,
    mcUSD: number,
    poolSol: number,
    heliosBrief?: string
  ): void {
    void this.notifyRadarEntry(token, poolSol, mcUSD, undefined, heliosBrief);
  }

  notifyAnalysis(_botId: string, token: string, mcUSD: number, poolSol: number): void {
    void this.notifyRadarEntry(token, poolSol, mcUSD);
  }

  notifyStart(
    botId: string,
    opNum: number,
    token: string,
    solInjected: number,
    priceUSD: number
  ): void {
    void this.sendText(
      `🤖 *[${botId}]* 🚀 *OPERACIÓN INICIADA (#${opNum})*\n• Token: \`${token}\`\n• Inversión: ${solInjected.toFixed(2)} SOL (Cartera A)\n• Precio: $${priceUSD.toFixed(8)} USD`
    );
  }

  notifyDerisk(botId: string, solReduced: number, currentExposed: number): void {
    void this.sendText(
      `🤖 *[${botId}]* ⚠️ *DESESCALADA DE RIESGO*\nRetirados: -${solReduced.toFixed(2)} SOL | Expuesto: ${currentExposed.toFixed(2)} SOL`
    );
  }

  notifyBoost(botId: string, solAdded: number, currentExposed: number): void {
    void this.sendText(
      `🤖 *[${botId}]* 🔥 *RE-INYECCIÓN POR RUPTURA*\nAñadidos: +${solAdded.toFixed(2)} SOL | Expuesto: ${currentExposed.toFixed(2)} SOL`
    );
  }

  notifyTakeProfit(
    botId: string,
    multiplier: number,
    amountUSD: number,
    type: string,
    walletAReturnedSol?: number,
    walletABalanceSol?: number
  ): void {
    const aLine =
      walletAReturnedSol !== undefined
        ? `\n• Vuelto a A: ${walletAReturnedSol >= 0 ? '+' : ''}${walletAReturnedSol.toFixed(4)} SOL`
        : '';
    const balLine =
      walletABalanceSol !== undefined
        ? `\n• Saldo A ahora: ${walletABalanceSol.toFixed(4)} SOL`
        : '';
    void this.sendText(
      `🤖 *[${botId}]* 💰 *TOMA DE COBERTURA (${type})*\nMultiplicador: ${multiplier.toFixed(1)}x | Cobertura Extraída: $${amountUSD.toFixed(2)} USD${aLine}${balLine}`
    );
  }

  notifyStagnantExit(botId: string, token: string): void {
    void this.sendText(
      `🤖 *[${botId}]* 😴 *SALIDA POR ESTANCAMIENTO*\nToken \`${token}\` cerrado tras 4 min sin tendencia.`
    );
  }

  notifySummary(
    botId: string,
    token: string,
    initialSol: number,
    pnlSol: number,
    vaultSol: number
  ): void {
    const emoji = pnlSol >= 0 ? '🟢 GANANCIA' : '🔴 PÉRDIDA';
    void this.sendText(
      `🤖 *[${botId}]* ✅ *RESUMEN DE OPERACIÓN*\n• Token: \`${token}\`\n• Inversión Inicial: ${initialSol.toFixed(2)} SOL\n• PnL Net: ${emoji} ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(2)} SOL\n• Ruteo a Cartera B (Vault): ${vaultSol.toFixed(2)} SOL`
    );
  }
}
