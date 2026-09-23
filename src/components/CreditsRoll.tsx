import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface CreditsRollProps {
    onClose: () => void;
}

export type SceneTone = 'normal' | 'code' | 'quiet' | 'final' | 'cat' | 'echo' | 'curtain';
export type FontSizeLevel = 'hero' | 'large' | 'medium' | 'stat';

export interface EasterEggScene {
    id: string;
    lines: string[];
    tone?: SceneTone;
    fontSizeLevel?: FontSizeLevel;
    fadeIn?: number;     // 毫秒，淡入时长
    hold?: number;       // 毫秒，停留时长
    fadeOut?: number;    // 毫秒，淡出时长
    pauseAfter?: number; // 毫秒，纯黑场呼吸停顿
    showLogos?: boolean; // 是否展示终极品牌与项目 Logo
}

type PlaybackPhase = 'fade-in' | 'hold' | 'fade-out' | 'blackout' | 'ended';

/**
 * 电影式文字蒙太奇镜头序列（加速节奏，紧凑而富有诗意）
 */
const SCENES: EasterEggScene[] = [
    // ── 序章：起点 ──
    {
        id: 'prologue-1',
        lines: ['它以前不是现在这样。'],
        fontSizeLevel: 'large',
        hold: 1600,
    },
    {
        id: 'prologue-2',
        lines: ['它只是一个网页。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        id: 'old-pixel',
        lines: ['有像素风。'],
        fontSizeLevel: 'large',
        hold: 1200,
    },
    {
        id: 'old-cat',
        lines: ['有一只猫。'],
        fontSizeLevel: 'large',
        tone: 'cat',
        hold: 1300,
    },
    {
        id: 'old-cf-worker',
        lines: ['有 Cloudflare Worker。'],
        fontSizeLevel: 'large',
        hold: 1300,
    },
    {
        id: 'old-d1',
        lines: ['有 D1。'],
        fontSizeLevel: 'hero',
        hold: 1100,
    },
    {
        id: 'old-r2',
        lines: ['有 R2。'],
        fontSizeLevel: 'hero',
        hold: 1100,
    },
    {
        id: 'old-vanished',
        lines: ['后来，', '这些都不见了。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1600,
    },
    {
        id: 'old-why-not',
        lines: ['它们都还好。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        id: 'old-dest',
        lines: ['只是项目要去别的地方了。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1700,
    },

    // ── 第二幕：生长与技术大字 ──
    {
        id: 'grow-start',
        lines: ['后来，', '它开始长大。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        id: 'tech-postgres',
        lines: ['PostgreSQL。'],
        fontSizeLevel: 'hero',
        tone: 'code',
        hold: 1100,
    },
    {
        id: 'tech-mcp',
        lines: ['MCP。'],
        fontSizeLevel: 'hero',
        tone: 'code',
        hold: 1100,
    },
    {
        id: 'tech-crypto',
        lines: ['加密。'],
        fontSizeLevel: 'hero',
        tone: 'code',
        hold: 1100,
    },
    {
        id: 'tech-sync',
        lines: ['同步。'],
        fontSizeLevel: 'hero',
        tone: 'code',
        hold: 1100,
    },
    {
        id: 'tech-ocr',
        lines: ['OCR。'],
        fontSizeLevel: 'hero',
        tone: 'code',
        hold: 1100,
    },
    {
        id: 'tech-code-grows',
        lines: ['代码越来越多。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        id: 'tech-contrast',
        lines: ['但产品真正面对的，', '仍然是一个人。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1800,
    },

    // ── 第三幕：数据猫的轻声注视 ──
    {
        id: 'cat-mcp-ask',
        lines: ['数据猫：', '「所以现在 AI 也能找到我了？」'],
        fontSizeLevel: 'large',
        tone: 'cat',
        hold: 1900,
    },
    {
        id: 'cat-mcp-reply',
        lines: ['…… 是的。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1300,
    },

    // ── 第四幕：克制与边界 ──
    {
        id: 'boundary-aesthetic',
        lines: ['有些事情，', '不能因为看起来很漂亮，', '就把它写进软件。'],
        fontSizeLevel: 'large',
        hold: 1800,
    },
    {
        id: 'boundary-pk',
        lines: ['记录，可以。', '虚构一个等效浓度，不可以。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1800,
    },
    {
        id: 'boundary-doctor',
        lines: ['软件负责保存数据。', '医生的话，留给医生。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1800,
    },
    {
        id: 'boundary-security',
        lines: ['安全是一条边界。'],
        fontSizeLevel: 'large',
        hold: 1700,
    },

    // ── 第五幕：历史痕迹与不可重写的数学 ──
    {
        id: 'history-intro',
        lines: ['这里曾经发生过一些事情。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        // 相对上游仓库的全部改动。数字是 `git diff upstream/main...HEAD` 的量级，
        // 每次都重算、写死在这里——这一帧是给人看的，不是仪表盘。
        id: 'diff-plus',
        lines: ['+63,894'],
        fontSizeLevel: 'stat',
        tone: 'code',
        hold: 1300,
    },
    {
        id: 'diff-minus',
        lines: ['-28,027'],
        fontSizeLevel: 'stat',
        tone: 'code',
        hold: 1300,
    },
    {
        id: 'diff-deleted',
        lines: ['很多东西被删掉了。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        id: 'diff-reborn',
        lines: ['很多东西重新长了出来。'],
        fontSizeLevel: 'large',
        hold: 1500,
    },
    {
        id: 'diff-changes',
        lines: ['架构变了。', '界面变了。', '数据库变了。', 'AI 接入方式变了。'],
        fontSizeLevel: 'large',
        hold: 2100,
    },
    {
        id: 'diff-one-thing',
        lines: ['一样东西留了下来。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1700,
    },
    {
        id: 'math-core',
        lines: ['数学。'],
        fontSizeLevel: 'hero',
        tone: 'final',
        hold: 2200,
    },
    {
        id: 'math-models',
        lines: ['三室开放模型。', '双相肌注吸收动力学。', '舌下含服模型。'],
        fontSizeLevel: 'medium',
        tone: 'code',
        hold: 2000,
    },
    {
        id: 'engine-second',
        lines: ['后来，', '有人又写了另一个模型。'],
        fontSizeLevel: 'large',
        hold: 1700,
    },
    {
        id: 'engine-second-name',
        lines: ['Transmtf。'],
        fontSizeLevel: 'hero',
        tone: 'code',
        hold: 1300,
    },
    {
        id: 'engine-two-algorithms',
        lines: ['我们把它接了进来。', '同一个问题，', '从此有两种算法。'],
        fontSizeLevel: 'large',
        hold: 2100,
    },
    {
        id: 'launch-after',
        lines: ['上线之后，', '事情才真正开始。'],
        fontSizeLevel: 'large',
        hold: 1800,
    },
    {
        id: 'bugs-surface',
        lines: ['一堆 bug 冒了出来。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1700,
    },
    {
        id: 'bugs-two-kinds',
        lines: ['有的藏了很久，', '有的才刚学会走路。'],
        fontSizeLevel: 'large',
        hold: 1900,
    },
    {
        id: 'bugs-fix',
        lines: ['修好一个，', '又看见一个。'],
        fontSizeLevel: 'large',
        hold: 1900,
    },
    {
        id: 'bugs-lesson',
        lines: ['大概这就是，', '软件长大的方式。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 2100,
    },
    {
        id: 'math-contact',
        lines: ['在复用这部分工作之前，', '我们联系了原作者。'],
        fontSizeLevel: 'large',
        hold: 1700,
    },
    {
        id: 'math-reply',
        lines: ['对方回复了：', '「可以。」'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1600,
    },
    {
        id: 'opensource-message',
        lines: ['开源有时候很小：', '一个开发者回复了另一个开发者。'],
        fontSizeLevel: 'large',
        hold: 2000,
    },

    // ── 第六幕：开源致谢 ──
    {
        id: 'tribute-algo',
        lines: ['有人写出了算法。'],
        fontSizeLevel: 'large',
        hold: 1300,
    },
    {
        id: 'tribute-code',
        lines: ['有人公开了代码。'],
        fontSizeLevel: 'large',
        hold: 1300,
    },
    {
        id: 'tribute-deps',
        lines: ['有人维护了依赖。'],
        fontSizeLevel: 'large',
        hold: 1300,
    },
    {
        id: 'tribute-docs',
        lines: ['有人认真写了文档。'],
        fontSizeLevel: 'large',
        hold: 1300,
    },
    {
        id: 'tribute-email',
        lines: ['有人回答了一封邮件。'],
        fontSizeLevel: 'large',
        hold: 1300,
    },
    {
        id: 'tribute-continue',
        lines: ['有人继续往下写。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1600,
    },
    {
        id: 'tribute-together',
        lines: ['我们能做的，', '是把这些东西接到一起。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1800,
    },
    {
        id: 'tribute-foundations',
        lines: ['致敬所有留下基石的人。', 'HRT-Recorder-PKcomponent-Test · Transmtf · Oyama\'s HRT Tracker'],
        fontSizeLevel: 'medium',
        hold: 2200,
    },

    // ── 第七幕：跨性别社区与人（最安静的时刻） ──
    {
        id: 'cat-ask-record',
        lines: ['数据猫：', '「所以我们到底在记录什么？」'],
        fontSizeLevel: 'large',
        tone: 'cat',
        hold: 1800,
    },
    {
        id: 'quiet-ellipsis',
        lines: ['……'],
        fontSizeLevel: 'hero',
        tone: 'quiet',
        hold: 1200,
    },
    {
        id: 'person-not-code',
        lines: ['这个项目想记下的，', '不只是代码。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1800,
    },
    {
        id: 'person-lab',
        lines: ['一项化验结果后面，', '有一个正在生活的人。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1900,
    },
    {
        id: 'person-med',
        lines: ['一次用药记录后面，', '有一个正在摸索自己身体的人。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1900,
    },
    {
        id: 'person-survey-1',
        lines: ['一份问卷后面，', '有具体的答案。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1800,
    },
    {
        id: 'person-survey-2',
        lines: ['它后面，', '是一个真的填写过答案的人。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1900,
    },
    {
        id: 'person-becoming',
        lines: ['我们记录的，', '是一些人正在成为自己。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 2200,
    },
    {
        id: 'person-respect',
        lines: ['一次不被打断的自我介绍。', '一个被正确称呼的名字。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 1900,
    },
    {
        id: 'person-care',
        lines: ['有时候，所谓关怀，', '只是有人愿意认真对待', '另一个人的存在。'],
        fontSizeLevel: 'medium',
        tone: 'quiet',
        hold: 2300,
    },

    // ── 第八幕：真实与重量 ──
    {
        id: 'truth-no-fancy',
        lines: ['我们不追求制造一个漂亮的答案。'],
        fontSizeLevel: 'large',
        hold: 1700,
    },
    {
        id: 'truth-hope',
        lines: ['我们更希望留下：', '足够可靠的问题、', '足够诚实的证据、', '足够长久的记录。'],
        fontSizeLevel: 'medium',
        hold: 2400,
    },
    {
        id: 'truth-worthy',
        lines: ['因为真实发生过的事情，', '值得被认真记录。'],
        fontSizeLevel: 'large',
        tone: 'quiet',
        hold: 2100,
    },

    // ── 第九幕：猫的轻语 ──
    {
        id: 'cat-record-ask',
        lines: ['数据猫：', '「先记录下来吧。」'],
        fontSizeLevel: 'large',
        tone: 'cat',
        hold: 1700,
    },
    {
        id: 'cat-silence',
        // Was a cat emoji. The roll carries no pictographs now — a font-rendered
        // emoji looked different on every platform, and this is a black screen with
        // set type, where that variance is the one thing that reads as not designed.
        // The cat's line, in the same brackets it speaks in everywhere else.
        lines: ['「喵。」'],
        fontSizeLevel: 'hero',
        tone: 'cat',
        hold: 1500,
    },

    // ── 第十幕：终极视觉中心 ──
    {
        id: 'climax-become-yourself',
        lines: ['愿你有一天，', '可以很平静地成为自己。'],
        fontSizeLevel: 'hero',
        tone: 'final',
        fadeIn: 1400,
        hold: 4200,
        fadeOut: 1800,
        pauseAfter: 1200,
    },

    // ── 余韵：落幕 ──
    {
        id: 'afterglow-thanks',
        lines: ['感谢你看到这里。'],
        fontSizeLevel: 'medium',
        tone: 'echo',
        hold: 2000,
    },
    {
        id: 'afterglow-brand',
        // The inscription used to sit on this line. It was asked for twice -- once
        // here and once under the curtain call -- and removed from both, so the roll
        // ends on the name and the cat's line rather than on a saying.
        lines: ['Kira HRT Tracker'],
        fontSizeLevel: 'medium',
        tone: 'echo',
        hold: 2400,
    },
    {
        id: 'afterglow-cat',
        // The same two characters it opened its mouth with after the last question —
        // a bookend rather than a new line. Emoji removed; see `cat-silence`.
        lines: ['「喵。」'],
        fontSizeLevel: 'large',
        tone: 'echo',
        hold: 1600,
        fadeOut: 1600,
        pauseAfter: 1000,
    },

    // ── 终章谢幕：双 Logo 与许可致谢 ──
    {
        id: 'curtain-call-logos',
        lines: [],
        tone: 'curtain',
        showLogos: true,
        fadeIn: 1600,
        hold: 4600,
        fadeOut: 2200,
        pauseAfter: 1500,
    },
];

export const CreditsRoll: React.FC<CreditsRollProps> = ({ onClose }) => {
    const [sceneIndex, setSceneIndex] = useState<number>(0);
    const [phase, setPhase] = useState<PlaybackPhase>('fade-in');
    const [isExiting, setIsExiting] = useState<boolean>(false);
    const [isMuted, setIsMuted] = useState<boolean>(false);
    const [showControls, setShowControls] = useState<boolean>(false);

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isExitingRef = useRef<boolean>(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const hideControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const currentScene = useMemo(() => {
        return SCENES[sceneIndex] || SCENES[SCENES.length - 1];
    }, [sceneIndex]);

    // 紧凑从容的动画节奏
    const fadeInDuration = currentScene.fadeIn ?? 800;
    const holdDuration = currentScene.hold ?? 1600;
    const fadeOutDuration = currentScene.fadeOut ?? 900;
    const pauseAfterDuration = currentScene.pauseAfter ?? 500;

    /**
     * How long the roll still has to run, from the scene on screen right now.
     *
     * The music is fitted to the picture rather than the other way round: the roll is
     * scripted and a visitor can advance it by hand, so the picture is the one thing
     * whose length is actually known. This is the remaining script time plus the tail
     * `ended` holds before `handleExit` — the total the music has to cover.
     *
     * Keyed on `sceneIndex` alone, deliberately. The current scene's `fadeIn` is the
     * only piece not counted, because entering a scene always sets phase to `fade-in`
     * and that fade has already elapsed by the time its `hold` begins — so the scenes
     * ahead are whole and the current one is `hold + fadeOut + pauseAfter`. Its stamp
     * would change on every phase tick if the elapsed time were tracked, which would
     * re-arm the fade below four times a scene; it does not, and the schedule is
     * therefore armed once per scene, which is what "re-fit on skip" needs.
     */
    const remainingRollMs = useMemo(() => {
        let total = 0;
        for (let i = sceneIndex; i < SCENES.length; i++) {
            const s = SCENES[i];
            const isCurrent = i === sceneIndex;
            total += (isCurrent ? 0 : (s.fadeIn ?? 800))
                + (s.hold ?? 1600)
                + (s.fadeOut ?? 900)
                + (s.pauseAfter ?? 500);
        }
        return total + 1500; // the `ended` tail before handleExit
    }, [sceneIndex]);

    const clearCurrentTimer = () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    };

    // 背景音乐初始化与播放（默认音量 10%）
    //
    // The music has to cover the whole roll and then end with it, which takes two
    // things because the two lengths are not the same.
    //
    // **Cover it.** The track runs about 137 s; the roll runs about 259 s. Unlooped,
    // the music simply ran out a little over halfway through and the rest of the
    // credits played in silence. It loops so there is still music to fade.
    //
    // **End with it.** The roll is scripted and a visitor can advance it by hand, so
    // the *picture* is the thing whose length is known. The loop has no end of its own
    // to align with, so the fade is scheduled to finish when the roll does, from
    // `remainingRollMs`; a manual exit starts the same ramp immediately. Both paths
    // share one stop function, so "fade out and end" has one definition.
    //
    // The ramp is capped at 2s and floored at 400ms: a longer fall from a short
    // remaining time is a cut rather than an ending, and a shorter one is audible as a
    // click on the way to silence.
    const musicStopRef = useRef<(() => void) | null>(null);
    const musicFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const audio = new Audio('/audio/easter-egg-music.mp3');
        // Looped so the track outlasts the roll rather than ending inside it — see the
        // note above. The end is the fade, not the file.
        audio.loop = true;
        audio.volume = 0.1;
        audioRef.current = audio;

        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.catch(() => {
                // 浏览器自动播放拦截处理
            });
        }

        let fadeTimer: ReturnType<typeof setInterval> | null = null;
        let stopped = false;
        /** Ramp down to silence over `rampMs`, then stop the element outright. */
        const fadeOut = (rampMs: number) => {
            if (stopped) return;
            stopped = true;
            if (fadeTimer) clearInterval(fadeTimer);
            const stepMs = 50;
            const step = audio.volume / Math.max(1, Math.round(rampMs / stepMs));
            fadeTimer = setInterval(() => {
                if (audio.volume > step) {
                    audio.volume = Math.max(0, audio.volume - step);
                    return;
                }
                if (fadeTimer) clearInterval(fadeTimer);
                fadeTimer = null;
                audio.pause();
                audio.currentTime = 0;
            }, stepMs);
        };
        const stopMusic = () => {
            if (musicFadeRef.current) {
                clearTimeout(musicFadeRef.current);
                musicFadeRef.current = null;
            }
            fadeOut(250);
        };
        musicStopRef.current = stopMusic;

        return () => {
            stopped = true;
            if (fadeTimer) clearInterval(fadeTimer);
            if (musicFadeRef.current) clearTimeout(musicFadeRef.current);
            musicFadeRef.current = null;
            audio.pause();
            audio.currentTime = 0;
            musicStopRef.current = null;
            audioRef.current = null;
        };
    }, []);

    // Keep the fade armed against the roll's remaining time: it must *end* with the
    // picture, so it starts one ramp-length before then. Re-armed per scene, which is
    // what makes skipping ahead re-fit rather than leave a stale schedule.
    useEffect(() => {
        if (musicFadeRef.current) {
            clearTimeout(musicFadeRef.current);
            musicFadeRef.current = null;
        }
        if (isExitingRef.current) return;
        const rampMs = Math.min(2000, Math.max(400, Math.round(remainingRollMs / 4)));
        const delay = Math.max(0, remainingRollMs - rampMs);
        musicFadeRef.current = setTimeout(() => {
            musicFadeRef.current = null;
            musicStopRef.current?.();
        }, delay);
        return () => {
            if (musicFadeRef.current) {
                clearTimeout(musicFadeRef.current);
                musicFadeRef.current = null;
            }
        };
    }, [remainingRollMs]);

    // Stop as soon as the user leaves, so the music and the picture end together —
    // `handleExit` is the one path out, whether the roll finished or was closed.
    const handleExit = useCallback(() => {
        if (isExitingRef.current) return;
        isExitingRef.current = true;
        setIsExiting(true);
        clearCurrentTimer();
        setPhase('fade-out');
        musicStopRef.current?.();

        setTimeout(() => {
            onClose();
        }, 1000);
    }, [onClose]);

    // 锁定 body 滚动条
    useEffect(() => {
        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = originalOverflow;
        };
    }, []);

    // 切换音乐静音
    const toggleMusic = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!audioRef.current) return;
        if (isMuted) {
            audioRef.current.muted = false;
            audioRef.current.volume = 0.1;
            audioRef.current.play().catch(() => {});
            setIsMuted(false);
        } else {
            audioRef.current.muted = true;
            setIsMuted(true);
        }
    };

    // 全局平滑退出
    // (defined above the mute toggle — it stops the music as well as the timers)

    // 手动推进下一镜头
    const handleAdvance = useCallback(() => {
        if (isExitingRef.current) return;

        if (audioRef.current && audioRef.current.paused && !isMuted) {
            audioRef.current.play().catch(() => {});
        }

        if (phase === 'ended') {
            handleExit();
        } else if (phase === 'fade-in' || phase === 'hold') {
            clearCurrentTimer();
            setPhase('fade-out');
            timerRef.current = setTimeout(() => {
                setPhase('blackout');
                timerRef.current = setTimeout(() => {
                    if (sceneIndex < SCENES.length - 1) {
                        setSceneIndex((prev) => prev + 1);
                        setPhase('fade-in');
                    } else {
                        handleExit();
                    }
                }, 200);
            }, 400);
        } else if (phase === 'blackout') {
            clearCurrentTimer();
            if (sceneIndex < SCENES.length - 1) {
                setSceneIndex((prev) => prev + 1);
                setPhase('fade-in');
            } else {
                handleExit();
            }
        }
    }, [phase, sceneIndex, handleExit, isMuted]);

    // 鼠标移动显示控件，随后隐匿
    const handleMouseMove = () => {
        setShowControls(true);
        if (hideControlsTimerRef.current) {
            clearTimeout(hideControlsTimerRef.current);
        }
        hideControlsTimerRef.current = setTimeout(() => {
            setShowControls(false);
        }, 1800);
    };

    // 键盘监听
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                handleExit();
            } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
                e.preventDefault();
                handleAdvance();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleExit, handleAdvance]);

    // 电影状态机循环
    useEffect(() => {
        if (isExitingRef.current) return;
        clearCurrentTimer();

        if (phase === 'fade-in') {
            timerRef.current = setTimeout(() => {
                setPhase('hold');
            }, fadeInDuration);
        } else if (phase === 'hold') {
            timerRef.current = setTimeout(() => {
                setPhase('fade-out');
            }, holdDuration);
        } else if (phase === 'fade-out') {
            timerRef.current = setTimeout(() => {
                setPhase('blackout');
            }, fadeOutDuration);
        } else if (phase === 'blackout') {
            timerRef.current = setTimeout(() => {
                if (sceneIndex < SCENES.length - 1) {
                    setSceneIndex((prev) => prev + 1);
                    setPhase('fade-in');
                } else {
                    setPhase('ended');
                }
            }, pauseAfterDuration);
        } else if (phase === 'ended') {
            // 终章黑场收尾：由状态机（而非手动推进）负责自动退出
            timerRef.current = setTimeout(() => {
                handleExit();
            }, 1500);
        }

        return () => {
            clearCurrentTimer();
        };
    }, [phase, sceneIndex, fadeInDuration, holdDuration, fadeOutDuration, pauseAfterDuration, handleExit]);

    // 自适应字号样式
    const getTypographyClass = (scene: EasterEggScene) => {
        switch (scene.fontSizeLevel) {
            case 'hero':
                return 'text-[clamp(2.4rem,6.8vw,6.5rem)] font-medium leading-[1.3] tracking-widest';
            case 'stat':
                return 'text-[clamp(3.2rem,10.5vw,8.5rem)] font-mono font-light tracking-wider';
            case 'large':
                return 'text-[clamp(1.75rem,4.6vw,4.2rem)] font-normal leading-[1.4] tracking-wider';
            case 'medium':
            default:
                return 'text-[clamp(1.3rem,3.2vw,2.8rem)] font-light leading-[1.6] tracking-wide';
        }
    };

    const getTextColorClass = (scene: EasterEggScene) => {
        if (scene.id === 'diff-plus') return 'text-emerald-400';
        if (scene.id === 'diff-minus') return 'text-rose-400';
        if (scene.tone === 'final') return 'text-[#ffffff]';
        if (scene.tone === 'echo') return 'text-[#d4d4d8]';
        if (scene.tone === 'cat') return 'text-[#fef3c7]';
        return 'text-[#f4f4f5]';
    };

    return createPortal(
        <div
            onClick={handleAdvance}
            onMouseMove={handleMouseMove}
            className="fixed inset-0 w-screen h-screen min-w-[100vw] min-h-[100dvh] z-[999999] bg-black text-[#f4f4f5] font-sans select-none cursor-pointer overflow-hidden flex flex-col items-center justify-center"
            style={{
                opacity: isExiting ? 0 : 1,
                transition: 'opacity 1000ms cubic-bezier(0.25, 0.1, 0.25, 1)',
            }}
        >
            {/* 内联关键帧动画：从 0 柔和呼吸浮现 */}
            <style>{`
                @keyframes montageFadeInAnim {
                    0% {
                        opacity: 0;
                        transform: scale(0.975);
                        filter: blur(4px);
                    }
                    100% {
                        opacity: 1;
                        transform: scale(1);
                        filter: blur(0px);
                    }
                }
                @keyframes montageFadeOutAnim {
                    0% {
                        opacity: 1;
                        transform: scale(1);
                        filter: blur(0px);
                    }
                    100% {
                        opacity: 0;
                        transform: scale(1.015);
                        filter: blur(3px);
                    }
                }
                .montage-fade-in {
                    animation: montageFadeInAnim ${fadeInDuration}ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }
                .montage-hold {
                    opacity: 1;
                    transform: scale(1);
                    filter: blur(0px);
                }
                .montage-fade-out {
                    animation: montageFadeOutAnim ${fadeOutDuration}ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
                }
                .montage-blackout {
                    opacity: 0;
                    transform: scale(1);
                    pointer-events: none;
                }
            `}</style>

            {/* 右上角轻微的音乐按钮与退出按钮（平时微弱透明，移动时显现） */}
            <div
                className={`fixed top-6 right-6 z-20 flex items-center gap-4 transition-opacity duration-700 ${
                    showControls ? 'opacity-80' : 'opacity-20 hover:opacity-100'
                }`}
            >
                <button
                    type="button"
                    onClick={toggleMusic}
                    aria-label={isMuted ? '开启音乐' : '静音'}
                    className="p-2.5 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-colors"
                >
                    {isMuted ? (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                        </svg>
                    ) : (
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                        </svg>
                    )}
                </button>

                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        handleExit();
                    }}
                    aria-label="退出片尾"
                    className="p-2.5 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-colors"
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* 核心镜头主体 */}
            <div
                key={`${currentScene.id}-${phase}`}
                className={`w-full h-full flex flex-col items-center justify-center px-6 md:px-16 max-w-5xl mx-auto text-center pointer-events-none ${
                    phase === 'fade-in'
                        ? 'montage-fade-in'
                        : phase === 'hold'
                        ? 'montage-hold'
                        : phase === 'fade-out'
                        ? 'montage-fade-out'
                        : 'montage-blackout'
                }`}
            >
                {/* 终章谢幕：双 Logo 与版权致谢镜头 */}
                {currentScene.showLogos ? (
                    <div className="flex flex-col items-center justify-center space-y-8 select-none">
                        {/* 双 Logo 居中对称微光呈现 */}
                        <div className="flex items-center justify-center gap-8 md:gap-12">
                            {/* Kira HRT Tracker 网页主图标 */}
                            <div className="flex flex-col items-center gap-3">
                                <img
                                    src="/pwa-512x512.png"
                                    alt="Kira HRT Tracker"
                                    className="w-16 h-16 md:w-20 md:h-20 object-contain"
                                />
                                <span className="text-xs md:text-sm text-zinc-300 font-mono tracking-wider">
                                    Kira HRT Tracker
                                </span>
                            </div>

                            <div className="text-zinc-600 text-xl font-light">×</div>

                            {/* KiraEqual Logo */}
                            <div className="flex flex-col items-center gap-3">
                                <img
                                    src="/kiraequal-logo.png"
                                    alt="KiraEqual"
                                    className="w-16 h-16 md:w-20 md:h-20 object-contain"
                                />
                                <span className="text-xs md:text-sm text-zinc-300 font-mono tracking-wider">
                                    KiraEqual
                                </span>
                            </div>
                        </div>

                        {/* 谢幕 */}
                        <div className="space-y-3 pt-2">
                            <p className="text-xs md:text-sm text-zinc-500 font-mono tracking-wider">
                                © 2026 KiraEqual · All Rights Reserved
                            </p>
                            <p className="text-[11px] text-zinc-600 font-mono pt-2">
                                Music: Modern Classical Piano · andriih (Pixabay License)
                            </p>
                        </div>
                    </div>
                ) : (
                    /* 常规大字镜头 */
                    <div className={`space-y-4 md:space-y-6 ${getTypographyClass(currentScene)} ${getTextColorClass(currentScene)}`}>
                        {currentScene.lines.map((line, idx) => {
                            const isCatPrefix = currentScene.tone === 'cat' && idx === 0 && line.includes('数据猫');
                            if (isCatPrefix) {
                                return (
                                    <div key={idx} className="text-zinc-500 text-lg md:text-2xl font-mono tracking-widest mb-2">
                                        {line}
                                    </div>
                                );
                            }

                            if (currentScene.id === 'tribute-foundations' && idx === 1) {
                                return (
                                    // One work per line. Three names on one line overflow
                                    // a 390px screen, and `whitespace-nowrap` made it worse
                                    // rather than better — measured 429px against 359px,
                                    // because the browser then cannot break the longest
                                    // project name either. Stacked, it is a list of credits,
                                    // which is what a credits roll does anyway.
                                    <div key={idx} className="text-zinc-400 text-sm md:text-lg font-mono tracking-wider pt-2 space-y-0.5">
                                        {line.split(' · ').map((work) => (
                                            <div key={work}>{work}</div>
                                        ))}
                                    </div>
                                );
                            }

                            return (
                                <div key={idx} className="break-words">
                                    {line}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
};
