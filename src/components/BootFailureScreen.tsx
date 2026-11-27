import React, { useState } from 'react';
import type { Lang } from '../i18n/types';
import { resetLockStorage, resetRecordKeyAlias } from '../utils/appLock';
import { removeDataKeyBase64 } from '../utils/secureStore';

/**
 * The screen for a bootstrap that never reached React.
 *
 * `index.tsx`'s `mount()` runs before any provider exists, so a throw there used to
 * leave the window showing the WebView's own background colour: a blank grey page
 * with no text, no button, and nothing in the UI to suggest anything had failed. The
 * Android launch that prompted this is the one in `initSecureStore` (ciphertext from
 * another device, no key) — but the shape of the hole is general, so this catches
 * whatever `mount()` throws rather than that one case.
 *
 * Copy lives here rather than in the language packs for the same reason as
 * `lockCopy`: the packs are lazily imported, and a bootstrap that failed is exactly
 * the situation where assuming a pack can load is the wrong bet. Seven short strings
 * cost nothing next to the dictionary.
 */
interface BootCopy {
    title: string;
    body: string;
    reload: string;
    reset: string;
    confirmReset: string;
    confirmDesc: string;
}

const COPY: Record<Lang, BootCopy> = {
    zh: {
        title: '应用没能启动',
        body: '本机的记录密钥不可用，应用在读取数据时停下了。重新载入通常可以恢复；如果一直停在这里，请清除本机数据后重新登录，云端记录不受影响。',
        reload: '重新载入',
        reset: '清除本机数据',
        confirmReset: '确认清除并重启',
        confirmDesc: '这会删除本机尚未同步的记录和失效密钥，云端记录不受影响。',
    },
    'zh-TW': {
        title: '應用程式沒能啟動',
        body: '本機的紀錄金鑰無法使用，應用程式在讀取資料時停下了。重新載入通常可以恢復；如果一直停在這裡，請清除本機資料後重新登入，雲端紀錄不受影響。',
        reload: '重新載入',
        reset: '清除本機資料',
        confirmReset: '確認清除並重啟',
        confirmDesc: '這會刪除本機尚未同步的紀錄與失效金鑰，雲端紀錄不受影響。',
    },
    yue: {
        title: '應用程式開唔到',
        body: '部機嘅紀錄鎖匙用唔到，應用程式讀資料嗰陣停咗。重新載入通常搞得返；如果一直停喺度，請清除本機資料再重新登入，雲端紀錄唔受影響。',
        reload: '重新載入',
        reset: '清除本機資料',
        confirmReset: '確認清除並重開',
        confirmDesc: '咁做會刪除部機未同步嘅紀錄同失效鎖匙，雲端紀錄唔受影響。',
    },
    en: {
        title: "The app couldn't start",
        body: "This device's record key is unusable, so the app stopped while reading your data. Reloading usually recovers it; if it stays here, clear this device's data and sign in again — your records in the cloud are not affected.",
        reload: 'Reload',
        reset: 'Clear local data',
        confirmReset: 'Confirm clear & reload',
        confirmDesc: 'This erases unsynced local records and the broken key. Cloud records are not affected.',
    },
    ja: {
        title: 'アプリを起動できませんでした',
        body: 'この端末の記録キーが使えないため、データの読み込みで停止しました。再読み込みで復帰することがほとんどです。この画面のままの場合は、端末のデータを消去して再ログインしてください。クラウドの記録は影響を受けません。',
        reload: '再読み込み',
        reset: '端末データを消去',
        confirmReset: '消去して再読み込み',
        confirmDesc: '未同期の端末データと使えなくなったキーを削除します。クラウドの記録は影響を受けません。',
    },
    ko: {
        title: '앱을 시작하지 못했습니다',
        body: '이 기기의 기록 키를 사용할 수 없어 데이터를 읽는 중에 멈췄습니다. 새로 고치면 대부분 복구됩니다. 계속 이 화면에 머문다면 이 기기의 데이터를 지우고 다시 로그인하세요. 클라우드 기록은 영향을 받지 않습니다.',
        reload: '새로 고침',
        reset: '기기 데이터 지우기',
        confirmReset: '지우고 다시 불러오기',
        confirmDesc: '동기화되지 않은 로컬 기록과 손상된 키를 삭제합니다. 클라우드 기록은 영향을 받지 않습니다.',
    },
    tr: {
        title: 'Uygulama başlatılamadı',
        body: 'Bu cihazın kayıt anahtarı kullanılamıyor, bu yüzden uygulama verilerinizi okurken durdu. Yeniden yüklemek genellikle düzeltir; bu ekranda kalırsa cihaz verilerini temizleyip tekrar giriş yapın. Buluttaki kayıtlarınız etkilenmez.',
        reload: 'Yeniden yükle',
        reset: 'Yerel verileri temizle',
        confirmReset: 'Temizle ve yeniden yükle',
        confirmDesc: 'Bu işlem senkronize edilmemiş yerel kayıtları ve bozuk anahtarı siler. Bulut kayıtları etkilenmez.',
    },
};

const bootLang = (): Lang => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('hrt-lang'); } catch { /* private mode */ }
    return (saved === 'zh' || saved === 'zh-TW' || saved === 'yue' || saved === 'en'
        || saved === 'ja' || saved === 'ko' || saved === 'tr') ? saved : 'en';
};

const BootFailureScreen = ({ error }: { error: unknown }) => {
    const copy = COPY[bootLang()];
    const [confirming, setConfirming] = useState(false);
    const [wiping, setWiping] = useState(false);

    const wipe = async () => {
        if (wiping) return;
        setWiping(true);
        try { resetLockStorage(); } catch { /* best-effort */ }
        try { resetRecordKeyAlias(); } catch { /* best-effort */ }
        try { await removeDataKeyBase64(); } catch { /* best-effort */ }
        try { localStorage.clear(); } catch { /* private mode */ }
        window.location.reload();
    };

    return (
        <div
            style={{
                minHeight: '100vh',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
                padding: '24px',
                textAlign: 'center',
                background: 'var(--color-m3-surface, #0D0D12)',
                color: 'var(--color-m3-on-surface, #E6E1E5)',
                fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Noto Sans SC", sans-serif',
            }}
        >
            <b style={{ fontSize: 20, fontWeight: 800 }}>{copy.title}</b>
            <p style={{ margin: 0, maxWidth: 420, fontSize: 14, lineHeight: 1.7, opacity: 0.8 }}>
                {copy.body}
            </p>
            {error ? (
                <code
                    style={{
                        maxWidth: 420,
                        width: '100%',
                        overflowX: 'auto',
                        textAlign: 'left',
                        fontSize: 11.5,
                        lineHeight: 1.6,
                        padding: '10px 12px',
                        borderRadius: 12,
                        background: 'rgba(255,255,255,.06)',
                        opacity: 0.75,
                    }}
                >
                    {String(error)}
                </code>
            ) : null}
            <button
                type="button"
                onClick={() => window.location.reload()}
                disabled={wiping}
                style={{
                    minHeight: 48,
                    minWidth: 148,
                    padding: '0 22px',
                    border: 0,
                    borderRadius: 22,
                    background: 'var(--color-m3-primary, #F5A9B8)',
                    color: 'var(--color-m3-on-primary, #211016)',
                    font: 'inherit',
                    fontWeight: 700,
                    cursor: 'pointer',
                }}
            >
                {copy.reload}
            </button>
            <button
                type="button"
                disabled={wiping}
                onClick={() => {
                    if (!confirming) {
                        setConfirming(true);
                        return;
                    }
                    void wipe();
                }}
                style={{
                    minHeight: 44,
                    minWidth: 148,
                    padding: '0 20px',
                    border: 0,
                    borderRadius: 22,
                    background: 'var(--color-m3-error-container, rgba(255,107,107,.16))',
                    color: 'var(--color-m3-on-error-container, #FFB4AB)',
                    font: 'inherit',
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: 'pointer',
                }}
            >
                {confirming ? copy.confirmReset : copy.reset}
            </button>
            {confirming ? (
                <p style={{ margin: 0, maxWidth: 420, fontSize: 13, lineHeight: 1.6, color: 'var(--color-m3-error, #FFB4AB)' }}>
                    {copy.confirmDesc}
                </p>
            ) : null}
        </div>
    );
};

export default BootFailureScreen;
