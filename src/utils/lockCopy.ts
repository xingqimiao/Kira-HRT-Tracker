import type { Lang } from '../i18n/types';

/**
 * Copy for the two screens that render before the app (and its lazy language
 * packs) exist: the unlock surface and the clock disguise.
 *
 * The rest of the app reads `t()` from LanguageContext, but the bootstrap runs
 * before that provider mounts — and deliberately before any record is decrypted.
 * Keeping this small table here also keeps the unlock path free of the 776-key
 * packs, so a cold start pays for seven short strings, not the dictionary.
 */
export interface LockCopy {
    title: string;
    hint: string;
    failed: string;
    /** Shown when a biometric enrolment change made the lock key unusable. */
    invalidated: string;
    retry: string;
    reset: string;
    resetTitle: string;
    resetDesc: string;
    reEnroll: string;
    wipe: string;
    confirm: string;
    confirmDesc: string;
    done: string;
}

const COPY: Record<Lang, LockCopy> = {
    zh: {
        title: '应用已锁定',
        hint: '使用指纹或面容解锁',
        failed: '验证未通过，请重试',
        invalidated: "指纹或面容已更改，应用锁的密钥已被系统作废，本机记录无法再解开。清除本机数据并重新登录后会从云端恢复。",
        retry: '重试',
        reset: '重置',
        resetTitle: '无法解锁？',
        resetDesc: '如果生物识别已失效，可以重新录入，或清除本机数据后重新登录。尚未同步的记录会丢失，云端记录不受影响。',
        reEnroll: '重新录入生物识别',
        wipe: '重置本地数据并重新登录',
        confirm: '确认重置',
        confirmDesc: '将删除本机记录密钥、未同步的记录与登录状态。此操作不可撤销。',
        done: '已重置',
    },
    'zh-TW': {
        title: '應用程式已鎖定',
        hint: '使用指紋或臉部解鎖',
        failed: '驗證未通過，請重試',
        invalidated: "指紋或臉部已變更，應用程式鎖定的金鑰已被系統作廢，本機紀錄無法再解開。清除本機資料並重新登入後會從雲端還原。",
        retry: '重試',
        reset: '重設',
        resetTitle: '無法解鎖？',
        resetDesc: '如果生物辨識已失效，可以重新錄入，或清除本機資料後重新登入。尚未同步的紀錄會遺失，雲端紀錄不受影響。',
        reEnroll: '重新錄入生物辨識',
        wipe: '重設本機資料並重新登入',
        confirm: '確認重設',
        confirmDesc: '將刪除本機紀錄金鑰、尚未同步的紀錄與登入狀態。此操作無法復原。',
        done: '已重設',
    },
    yue: {
        title: '應用程式已鎖定',
        hint: '用指紋或者面容解鎖',
        failed: '驗證唔通過，請再試',
        invalidated: "指紋或者面容改咗，應用鎖嘅金鑰已經被系統作廢，本機紀錄解唔返。清除本機資料再登入就會由雲端還原。",
        retry: '再試',
        reset: '重設',
        resetTitle: '解唔到鎖？',
        resetDesc: '如果生物辨識失效，可以重新錄入，或者清除本機資料再登入。未同步嘅紀錄會唔見，雲端紀錄唔受影響。',
        reEnroll: '重新錄入生物辨識',
        wipe: '重設本機資料再登入',
        confirm: '確認重設',
        confirmDesc: '會刪除本機紀錄金鑰、未同步嘅紀錄同登入狀態，冇得復原。',
        done: '已重設',
    },
    en: {
        title: 'App locked',
        hint: 'Unlock with your fingerprint or face',
        failed: 'Authentication failed. Try again.',
        invalidated: "Your fingerprint or face changed, so the system invalidated the app-lock key and this device records can no longer be opened. Clear local data and sign in again to restore them from the cloud.",
        retry: 'Try again',
        reset: 'Reset',
        resetTitle: "Can't unlock?",
        resetDesc: 'If biometrics stopped working, enroll them again, or clear this device and sign in again. Records not yet synced will be lost; cloud records are not affected.',
        reEnroll: 'Re-enroll biometrics',
        wipe: 'Reset local data and sign in again',
        confirm: 'Confirm reset',
        confirmDesc: "This deletes the local record key, unsynced records and the sign-in state. It cannot be undone.",
        done: 'Reset complete',
    },
    ja: {
        title: 'アプリはロックされています',
        hint: '指紋または顔で解除',
        failed: '認証できませんでした。もう一度お試しください。',
        invalidated: "指紋または顔が変更されたため、アプリロックの鍵はシステムにより無効化され、この端末の記録は開けなくなりました。端末のデータを消去して再ログインするとクラウドから復元されます。",
        retry: '再試行',
        reset: 'リセット',
        resetTitle: 'ロックを解除できませんか？',
        resetDesc: '生体認証が使えなくなった場合は、再登録するか、この端末のデータを消去して再度サインインしてください。未同期の記録は失われますが、クラウドの記録は影響を受けません。',
        reEnroll: '生体認証を再登録',
        wipe: 'ローカルデータを消去して再サインイン',
        confirm: 'リセットを確認',
        confirmDesc: 'ローカルの記録キー、未同期の記録、サインイン状態を削除します。元に戻せません。',
        done: 'リセットしました',
    },
    ko: {
        title: '앱이 잠겨 있습니다',
        hint: '지문 또는 얼굴로 잠금 해제',
        failed: '인증하지 못했습니다. 다시 시도하세요.',
        invalidated: "지문이나 얼굴이 변경되어 시스템이 앱 잠금 키를 무효화했습니다. 이 기기의 기록은 더 이상 열 수 없습니다. 기기 데이터를 지우고 다시 로그인하면 클라우드에서 복원됩니다.",
        retry: '다시 시도',
        reset: '초기화',
        resetTitle: '잠금을 해제할 수 없나요?',
        resetDesc: '생체 인증이 작동하지 않으면 다시 등록하거나 이 기기의 데이터를 지우고 다시 로그인하세요. 동기화되지 않은 기록은 사라지지만 클라우드 기록은 영향을 받지 않습니다.',
        reEnroll: '생체 인증 다시 등록',
        wipe: '로컬 데이터를 지우고 다시 로그인',
        confirm: '초기화 확인',
        confirmDesc: '로컬 기록 키, 동기화되지 않은 기록, 로그인 상태를 삭제합니다. 되돌릴 수 없습니다.',
        done: '초기화됨',
    },
    tr: {
        title: 'Uygulama kilitli',
        hint: 'Parmak izi veya yüzünüzle kilidi açın',
        failed: 'Kimlik doğrulama başarısız. Tekrar deneyin.',
        invalidated: "Parmak iziniz veya yüzünüz değiştiği için sistem uygulama kilidi anahtarını geçersiz kıldı ve bu cihazdaki kayıtlar artık açılamıyor. Yerel verileri temizleyip yeniden giriş yapın; kayıtlar buluttan geri gelir.",
        retry: 'Tekrar dene',
        reset: 'Sıfırla',
        resetTitle: 'Kilit açılmıyor mu?',
        resetDesc: 'Biyometri çalışmıyorsa yeniden kaydedin veya bu cihazın verilerini silip tekrar giriş yapın. Henüz eşitlenmemiş kayıtlar kaybolur; bulut kayıtları etkilenmez.',
        reEnroll: 'Biyometriyi yeniden kaydet',
        wipe: 'Yerel verileri sil ve tekrar giriş yap',
        confirm: 'Sıfırlamayı onayla',
        confirmDesc: 'Yerel kayıt anahtarını, eşitlenmemiş kayıtları ve oturum durumunu siler. Geri alınamaz.',
        done: 'Sıfırlandı',
    },
};

/** The language the bootstrap should use, from the one boot key that holds it. */
export function bootLang(): Lang {
    const saved = localStorage.getItem('hrt-lang');
    if (saved === 'zh' || saved === 'zh-TW' || saved === 'yue' || saved === 'en' || saved === 'ja' || saved === 'ko' || saved === 'tr') {
        return saved;
    }
    return 'en';
}

export const lockCopy = (): LockCopy => COPY[bootLang()];

const CLOCK_LOCALE: Record<Lang, string> = {
    zh: 'zh-CN',
    'zh-TW': 'zh-TW',
    yue: 'zh-HK',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    tr: 'tr',
};

export const clockLocale = (): string => CLOCK_LOCALE[bootLang()];
