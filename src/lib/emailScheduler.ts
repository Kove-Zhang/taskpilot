import { useSettingsStore, useScannerStore } from '../store';
import { invoke } from '@tauri-apps/api/core';
import { decodeIMAPFolder } from './parser';
import { extractTodosFromContent, type AIResult } from './ai';
import { syncToNotion } from './notion';
import { logger } from './logger';
import { LazyStore } from '@tauri-apps/plugin-store';

export interface EmailHistoryItem {
    batchId: string;
    timestamp: number;
    emailUid: number;
    subject: string;
    sender: string;
    status: 'success' | 'failed';
    error?: string;
    aiResult?: AIResult;
    emailDate?: string;
    syncedToNotion?: boolean;
    folder?: string;
}

const historyStore = new LazyStore('email_history.enc');

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

async function processSingleEmail(email: any, batchId: string, folder: string, processedUids: string[]): Promise<EmailHistoryItem> {
    const { emailConfig } = useSettingsStore.getState();
    const fingerprint = `${folder}_${email.uid}`;
    
    if (processedUids.includes(fingerprint)) {
        logger.info(`Email UID ${email.uid} in ${folder} already processed, skipping.`);
        return {
            batchId,
            timestamp: Date.now(),
            emailUid: email.uid,
            subject: email.subject,
            sender: email.sender,
            emailDate: email.date,
            status: 'success', // Consider it success so it's not retried as error
            syncedToNotion: false, // or undefined, as it was skipped
            folder
        };
    }

    let attempt = 0;
    const maxAttempts = emailConfig.retryCount + 1;
    let lastError = '';

    let aiResult: AIResult | undefined = undefined;
    let synced = false;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            logger.info(`Processing email UID ${email.uid} (Attempt ${attempt})`);
            
            // 1. AI Extraction (truncation happens inside extractTodosFromContent)
            if (!aiResult) {
                const prompt = `邮件主题: ${email.subject}\n发件人: ${email.sender}\n日期: ${email.date}\n\n内容:\n${email.body_text}`;
                aiResult = await extractTodosFromContent(prompt, []);
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
                    folder: emailConfig.targetFolder,
                    uid: email.uid
                });
            }

            processedUids.push(fingerprint);
            return {
                batchId,
                timestamp: Date.now(),
                emailUid: email.uid,
                subject: email.subject,
                sender: email.sender,
                emailDate: email.date,
                status: 'success',
                aiResult,
                syncedToNotion: synced,
                folder
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
        subject: email.subject,
        sender: email.sender,
        emailDate: email.date,
        status: 'failed',
        error: lastError,
        aiResult,
        folder
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

    scannerStore.setRunning(true);
    lastRunTimestamp = Date.now();
    logger.info("Starting email scanner batch...");
    const batchId = `batch_${Date.now()}`;

    try {
        scannerStore.setProgressMsg('连接服务器...');
        let processedUids: string[] = await historyStore.get('processed_uids') || [];
        const folders = emailConfig.targetFolder ? emailConfig.targetFolder.split(',').map(f => f.trim()).filter(Boolean) : ['INBOX'];
        
        for (const folder of folders) {
            logger.info(`Fetching emails from folder: ${folder}`);
            try {
                scannerStore.setProgressMsg(`拉取目录 ${decodeIMAPFolder(folder)}...`);
                const sinceDays = isManual ? (emailConfig.manualReadDays || 7) : (emailConfig.autoReadDays || 3);
                const emails = await invoke('fetch_emails', {
                    host: emailConfig.host,
                    port: emailConfig.port,
                    user: emailConfig.user,
                    pass: emailConfig.pass,
                    ssl: emailConfig.ssl,
                    folder: folder,
                    unreadOnly: true,
                    sinceDays: sinceDays
                }) as any[];

                logger.info(`Fetched ${emails.length} unread emails from ${folder}.`);

                let processedCount = 0;
                for (const email of emails) {
                    processedCount++;
                    scannerStore.setProgressMsg(`处理中 (${processedCount}/${emails.length})...`);
                    const result = await processSingleEmail(email, batchId, folder, processedUids);
                    if (!processedUids.includes(`${folder}_${email.uid}`)) {
                        // If it wasn't added inside processSingleEmail, it means it skipped or failed
                    }
                    
                    // Immediately save to history for real-time feedback
                    if (result.aiResult || result.status === 'failed') {
                        let existing: EmailHistoryItem[] = await historyStore.get('history') || [];
                        existing.unshift(result);
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
        store.setProgressMsg('');
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
