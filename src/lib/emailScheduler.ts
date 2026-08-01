import { useSettingsStore, useScannerStore } from '../store';
import { invoke } from '@tauri-apps/api/core';
import { decodeIMAPFolder } from './imapFolder';
import { extractTodosFromContent, type AIResult } from './ai';
import { parseEmailThread } from './emailThreadParser';
import { syncToNotion } from './notion';
import { logger } from './logger';
import { LazyStore } from '@tauri-apps/plugin-store';
import { compressBase64Image } from './imageUtils';

export interface EmailHistoryItem {
    batchId: string;
    timestamp: number;
    emailUid: number;
    emailUidValidity?: number;
    subject: string;
    sender: string;
    status: 'success' | 'failed';
    error?: string;
    aiResult?: AIResult;
    emailDate?: string;
    syncedToNotion?: boolean;
    folder?: string;
    rawBodyText?: string;
    htmlBody?: string;
    inlineImages?: string[];
    reviewed?: boolean;
}

const historyStore = new LazyStore('email_history.enc');

interface FetchedEmail {
    uid: number;
    uid_validity?: number;
    sender: string;
    subject: string;
    date: string;
    body_text: string;
    html_body?: string | null;
    inline_images?: string[];
    parse_error?: string | null;
}

function getEmailFingerprint(folder: string, email: Pick<FetchedEmail, 'uid' | 'uid_validity'>): string {
    return `${folder}_${email.uid_validity ?? 'legacy'}_${email.uid}`;
}

// In-memory flag to prevent overlapping runs
let lastRunTimestamp = 0;

function shouldRunNow(): boolean {
    const { emailConfig } = useSettingsStore.getState();
    if (!emailConfig || !emailConfig.enabled) return false;

    const now = new Date();
    
    // Prevent running multiple times in the same minute, but also handle interval drift robustly
    const lastRunMinute = new Date(lastRunTimestamp).getMinutes();
    if (lastRunTimestamp > 0 && now.getMinutes() === lastRunMinute && (now.getTime() - lastRunTimestamp < 5 * 60000)) {
        return false;
    }
    
    // Check day of week
    if (!emailConfig.scheduleDays.includes(now.getDay())) {
        return false;
    }

    // Check time
    const { scheduleTime } = emailConfig;
    if (scheduleTime === 'every_1h') {
        return now.getMinutes() === 0;
    } else if (scheduleTime === 'every_3h') {
        return now.getHours() % 3 === 0 && now.getMinutes() === 0;
    } else {
        // Specific time like "09:00"
        if (!scheduleTime || !scheduleTime.includes(':')) return false;
        const [hourStr, minStr] = scheduleTime.split(':');
        const hour = parseInt(hourStr, 10);
        const min = parseInt(minStr, 10);
        return now.getHours() === hour && now.getMinutes() === min;
    }
}

async function processSingleEmail(email: FetchedEmail, batchId: string, folder: string, processedUids: string[]): Promise<EmailHistoryItem> {
    const { emailConfig } = useSettingsStore.getState();
    const fingerprint = getEmailFingerprint(folder, email);
    
    if (processedUids.includes(fingerprint)) {
        logger.info(`Email UID ${email.uid} in ${folder} already processed, skipping.`);
        return {
            batchId,
            timestamp: Date.now(),
            emailUid: email.uid,
            emailUidValidity: email.uid_validity,
            subject: email.subject,
            sender: email.sender,
            emailDate: email.date,
            status: 'success', // Consider it success so it's not retried as error
            syncedToNotion: false, // or undefined, as it was skipped
            folder,
            rawBodyText: email.body_text,
            htmlBody: email.html_body || undefined,
            inlineImages: email.inline_images || []
        };
    }

    if (email.parse_error) {
        const parseError = `邮件 UID ${email.uid} 无法解析：${email.parse_error}`;
        logger.error(parseError);
        processedUids.push(fingerprint);
        return {
            batchId,
            timestamp: Date.now(),
            emailUid: email.uid,
            emailUidValidity: email.uid_validity,
            subject: email.subject,
            sender: email.sender,
            emailDate: email.date,
            status: 'failed',
            error: parseError,
            folder,
            rawBodyText: email.body_text,
            htmlBody: email.html_body || undefined,
            inlineImages: email.inline_images || []
        };
    }

    let attempt = 0;
    const maxAttempts = emailConfig.retryCount + 1;
    let lastError = '';

    let aiResult: AIResult | undefined = undefined;
    let synced = false;
    let compressedImages: string[] = [];
    if (email.inline_images && email.inline_images.length > 0) {
        for (const imgStr of email.inline_images) {
            try {
                const compressed = await compressBase64Image(imgStr, 1280, 0.75);
                compressedImages.push(compressed);
            } catch (err) {
                logger.warn(`Failed to compress image in email ${email.uid}, using original`, err);
                compressedImages.push(imgStr);
            }
        }
    }

    while (attempt < maxAttempts) {
        attempt++;
        try {
            logger.info(`Processing email UID ${email.uid} (Attempt ${attempt})`);
            
            // 1. AI Extraction (with Smart Thread Stripping & Denoising)
            if (!aiResult) {
                let contentPayload = email.body_text;
                const threadParsed = parseEmailThread(email.body_text || '');
                if (threadParsed.hasHistory && threadParsed.historicalThreads.length > 0) {
                    logger.info(`Email ${email.uid} has thread history (${threadParsed.historicalThreads.length} replies, total ${threadParsed.totalWords} chars, history ${threadParsed.reducedWords} chars). Constructing denoised prompt...`);
                    
                    let denoised = `【本次最新核心发信/回信正文 (权重 100%，请重点提炼此处动作要求)】：\n${threadParsed.latestMessage}\n\n`;
                    denoised += `【历史转发与引用链背景摘要 (权重 20%，仅作为上下文与专业名词参考，切勿提取已完成的往期历史任务)】：\n`;
                    let historyTextLen = 0;
                    const maxHistoryLen = 4000;
                    for (const h of threadParsed.historicalThreads) {
                        const headerStr = `[历史回帖 #${h.index + 1} | ${h.sendTime || '近期'} | 发件人: ${h.sender || '未知'}] 主题: ${h.subject || '无'}\n`;
                        const snippet = h.content.length > 800 ? h.content.substring(0, 800) + ' ...(单篇后文略)' : h.content;
                        if (historyTextLen + headerStr.length + snippet.length > maxHistoryLen) {
                            denoised += `${headerStr}${snippet.substring(0, Math.max(0, maxHistoryLen - historyTextLen))}\n...(更早期的 ${threadParsed.historicalThreads.length - h.index} 封历史转帖已为节约 Token 自动降噪裁剪)\n`;
                            break;
                        }
                        denoised += `${headerStr}${snippet}\n---\n`;
                        historyTextLen += headerStr.length + snippet.length + 4;
                    }
                    contentPayload = denoised;
                }
                const prompt = `邮件主题: ${email.subject}\n发件人: ${email.sender}\n日期: ${email.date}\n\n内容:\n${contentPayload}`;
                aiResult = await extractTodosFromContent(prompt, compressedImages);
            }

            // 2. Notion Sync (Only if autoSyncToNotion is true)
            const notionDbId = useSettingsStore.getState().notionDatabaseId;
            if (emailConfig.autoSyncToNotion && aiResult.todos && aiResult.todos.length > 0 && notionDbId && !synced) {
                // Pre-process for sync if necessary
                const todosToSync = aiResult.todos.filter(t => !t.synced).map(t => ({ ...t, selected: true }));
                if (todosToSync.length > 0) {
                    const syncRes = await syncToNotion(todosToSync);
                    
                    syncRes.filter(r => r.success).forEach(r => {
                        const target = aiResult!.todos.find(t => t.id === r.id);
                        if (target) target.synced = true;
                    });
                    
                    const failed = syncRes.filter(r => !r.success);
                    if (failed.length > 0) {
                        throw new Error(`Notion sync failed for ${failed.length} items`);
                    }
                }
                synced = true;
            }

            // 3. Mark as read if configured
            if (emailConfig.markAsRead) {
                await invoke('mark_email_read', {
                    host: emailConfig.host,
                    port: emailConfig.port,
                    user: emailConfig.user,
                    pass: emailConfig.pass,
                    ssl: emailConfig.ssl,
                    folder: folder,
                    uid: email.uid
                });
            }

            processedUids.push(fingerprint);
            return {
                batchId,
                timestamp: Date.now(),
                emailUid: email.uid,
                emailUidValidity: email.uid_validity,
                subject: email.subject,
                sender: email.sender,
                emailDate: email.date,
                status: 'success',
                aiResult,
                syncedToNotion: synced,
                folder,
                rawBodyText: email.body_text,
                htmlBody: email.html_body || undefined,
                inlineImages: compressedImages
            };

        } catch (e: any) {
            lastError = typeof e === 'string' ? e : e.message || String(e);
            logger.error(`Error processing email ${email.uid}`, e);
            if (attempt >= maxAttempts) {
                break;
            }
            // Add a small delay before retry
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    return {
        batchId,
        timestamp: Date.now(),
        emailUid: email.uid,
        emailUidValidity: email.uid_validity,
        subject: email.subject,
        sender: email.sender,
        emailDate: email.date,
        status: 'failed',
        error: lastError,
        aiResult,
        folder,
        rawBodyText: email.body_text,
        htmlBody: email.html_body || undefined,
        inlineImages: compressedImages
    };
}

export async function forceRunEmailScanner(isManual: boolean = false) {
    const scannerStore = useScannerStore.getState();
    if (scannerStore.running) {
        logger.warn("Email scanner is already running, skipping.");
        return;
    }

    const { emailConfig } = useSettingsStore.getState();
    if (!emailConfig || !emailConfig.host || !emailConfig.user || !emailConfig.pass) {
        logger.warn("Email config is incomplete, cannot run scanner.");
        return;
    }

    scannerStore.resetScanControl();
    scannerStore.setRunning(true);
    lastRunTimestamp = Date.now();
    logger.info("Starting email scanner batch...");
    const batchId = `batch_${Date.now()}`;

    try {
        scannerStore.setProgressMsg('连接服务器...');
        let processedUids: string[] = await historyStore.get('processed_uids') || [];
        const folders = emailConfig.targetFolder ? emailConfig.targetFolder.split(',').map(f => f.trim()).filter(Boolean) : ['INBOX'];
        
        for (const folder of folders) {
            if (useScannerStore.getState().stopRequested) {
                logger.info("用户停止扫描，终止本次运行。");
                break;
            }
            while (useScannerStore.getState().paused && !useScannerStore.getState().stopRequested) {
                await new Promise(r => setTimeout(r, 500));
            }
            if (useScannerStore.getState().stopRequested) {
                logger.info("用户停止扫描，终止本次运行。");
                break;
            }

            logger.info(`Fetching emails from folder: ${folder}`);
            try {
                scannerStore.setProgressMsg(`拉取目录 ${decodeIMAPFolder(folder)}...`);
                const sinceDays = isManual ? (emailConfig.manualReadDays || 7) : (emailConfig.autoReadDays || 3);
                const emails = await invoke('fetch_emails', {
                    request: {
                        host: emailConfig.host,
                        port: emailConfig.port,
                        user: emailConfig.user,
                        pass: emailConfig.pass,
                        ssl: emailConfig.ssl,
                        folder,
                        unreadOnly: !isManual,
                        sinceDays
                    }
                }) as FetchedEmail[];

                logger.info(`Fetched ${emails.length} ${isManual ? 'recent' : 'unread'} emails from ${folder}.`);

                let processedCount = 0;
                for (const email of emails) {
                    if (useScannerStore.getState().stopRequested) {
                        logger.info("用户停止扫描，终止本次运行。");
                        break;
                    }
                    while (useScannerStore.getState().paused && !useScannerStore.getState().stopRequested) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                    if (useScannerStore.getState().stopRequested) {
                        logger.info("用户停止扫描，终止本次运行。");
                        break;
                    }

                    processedCount++;
                    const shortSub = email.subject ? (email.subject.length > 18 ? email.subject.slice(0, 18) + '...' : email.subject) : '无主题';
                    scannerStore.setProgressMsg(`处理中 (${processedCount}/${emails.length}): ${shortSub}`);
                    const result = await processSingleEmail(email, batchId, folder, processedUids);
                    // Immediately save to history for real-time feedback (with deduplication for retried failed items)
                    if (result.aiResult || result.status === 'failed') {
                        let existing: EmailHistoryItem[] = await historyStore.get('history') || [];
                        const existingIdx = existing.findIndex(item => item.folder === result.folder && item.emailUidValidity === result.emailUidValidity && item.emailUid === result.emailUid);
                        if (existingIdx >= 0) {
                            existing[existingIdx] = result;
                        } else {
                            existing.unshift(result);
                        }
                        if (existing.length > 500) existing = existing.slice(0, 500);
                        await historyStore.set('history', existing);
                        await historyStore.save();
                        scannerStore.incrementHistoryVersion();
                    }

                    // Save processed UIDs to prevent duplicates in future runs incrementally
                    if (processedUids.length > 5000) {
                        processedUids = processedUids.slice(processedUids.length - 5000);
                    }
                    await historyStore.set('processed_uids', processedUids);
                }
            } catch (err) {
                logger.error(`Failed to fetch emails from folder ${folder}`, err);
            }
        }

        await historyStore.save();

        logger.info("Email scanner batch completed.");
    } catch (e) {
        logger.error("Failed to run email scanner", e);
    } finally {
        const store = useScannerStore.getState();
        store.setRunning(false);
        store.setPaused(false);
        if (store.stopRequested) {
            store.setProgressMsg('主动停止扫描');
        } else {
            store.setProgressMsg('扫描任务完成');
        }
    }
}

let timerInterval: any = null;

export function startEmailScheduler() {
    if (timerInterval) return;

    // Check every 10 seconds to prevent skipping due to interval drift
    timerInterval = setInterval(() => {
        if (shouldRunNow()) {
            forceRunEmailScanner(false).then(() => {
                // Do nothing
            });
        }
    }, 10 * 1000);
}

export function stopEmailScheduler() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}
