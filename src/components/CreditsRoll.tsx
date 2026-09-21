import React, { useEffect, useRef, useState, useCallback } from 'react';

interface CreditsRollProps {
    onClose: () => void;
}

/**
 * 开发者彩蛋与开源致谢片尾 (Developer Easter Egg & Credits Roll)
 *
 * 电影片尾字幕式慢速向上滚动组件。
 * 遵循极简沉浸、大量留白、深邃平静的设计原则。
 * 全程无医疗数据访问、纯前端独立实现，无额外重型依赖。
 */
export const CreditsRoll: React.FC<CreditsRollProps> = ({ onClose }) => {
    // 阶段：'intro' (过渡三段停顿文字) -> 'rolling' (正文滚动)
    const [phase, setPhase] = useState<'intro' | 'rolling'>('intro');
    const [introStep, setIntroStep] = useState<number>(0);
    const [isPaused, setIsPaused] = useState<boolean>(false);
    const [reducedMotion, setReducedMotion] = useState<boolean>(false);

    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const animFrameIdRef = useRef<number | null>(null);
    const isUserInteractingRef = useRef<boolean>(false);
    const resumeTimerRef = useRef<number | null>(null);

    // 检测系统的减弱动态设置
    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReducedMotion(mq.matches);
        const listener = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
        mq.addEventListener('change', listener);
        return () => mq.removeEventListener('change', listener);
    }, []);

    // 键盘支持：ESC 退出，空格切换暂停/继续
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            } else if (e.key === ' ' && phase === 'rolling') {
                e.preventDefault();
                setIsPaused((prev) => !prev);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose, phase]);

    // 第一阶段：入场呼吸式淡入文字 ("……" -> "等一下。" -> "好吧。")
    useEffect(() => {
        if (phase !== 'intro') return;

        const t1 = window.setTimeout(() => setIntroStep(1), 800);    // ……
        const t2 = window.setTimeout(() => setIntroStep(2), 2400);   // 等一下。
        const t3 = window.setTimeout(() => setIntroStep(3), 4200);   // 好吧。
        const t4 = window.setTimeout(() => setPhase('rolling'), 5800); // 真正进入片尾

        return () => {
            clearTimeout(t1);
            clearTimeout(t2);
            clearTimeout(t3);
            clearTimeout(t4);
        };
    }, [phase]);

    // 自动慢速平滑滚动引擎 (基于 requestAnimationFrame)
    useEffect(() => {
        if (phase !== 'rolling' || reducedMotion) return;

        const container = scrollContainerRef.current;
        if (!container) return;

        let lastTimestamp = performance.now();
        const scrollSpeedPxPerSec = 28; // 极其平缓的电影字幕上升速度 (约每秒 28 像素)

        const step = (now: number) => {
            const deltaMs = now - lastTimestamp;
            lastTimestamp = now;

            if (!isPaused && !isUserInteractingRef.current) {
                const maxScroll = container.scrollHeight - container.clientHeight;
                if (container.scrollTop < maxScroll) {
                    container.scrollTop += (scrollSpeedPxPerSec * deltaMs) / 1000;
                }
            }

            animFrameIdRef.current = requestAnimationFrame(step);
        };

        animFrameIdRef.current = requestAnimationFrame(step);

        return () => {
            if (animFrameIdRef.current) {
                cancelAnimationFrame(animFrameIdRef.current);
            }
        };
    }, [phase, isPaused, reducedMotion]);

    // 用户交互事件拦截：用户手动滚动/触摸时，暂时暂停自动滚动；停止交互 3.5 秒后平滑恢复
    const handleUserInteractionStart = useCallback(() => {
        isUserInteractingRef.current = true;
        if (resumeTimerRef.current) {
            clearTimeout(resumeTimerRef.current);
            resumeTimerRef.current = null;
        }
    }, []);

    const handleUserInteractionEnd = useCallback(() => {
        if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = window.setTimeout(() => {
            isUserInteractingRef.current = false;
        }, 3200);
    }, []);

    return (
        <div
            className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#090a0f] text-[#e2e8f0] select-none font-sans overflow-hidden transition-opacity duration-1000"
            style={{
                background: 'radial-gradient(ellipse at 50% 40%, #111420 0%, #08090d 100%)',
            }}
        >
            {/* 顶栏极简微型控制板 */}
            <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#090a0f]/90 via-[#090a0f]/50 to-transparent backdrop-blur-[2px] transition-opacity opacity-70 hover:opacity-100 focus-within:opacity-100">
                <span className="text-xs font-mono tracking-widest text-[#94a3b8]/70">
                    {phase === 'intro' ? 'WAIT' : isPaused ? 'PAUSED' : 'ROLLING'}
                </span>
                <div className="flex items-center gap-3">
                    {phase === 'rolling' && !reducedMotion && (
                        <button
                            type="button"
                            onClick={() => setIsPaused((prev) => !prev)}
                            className="px-2.5 py-1 text-xs tracking-wider text-[#94a3b8] hover:text-[#f8fafc] rounded border border-white/10 hover:border-white/25 transition-colors"
                        >
                            {isPaused ? '继续滚动' : '暂停'}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="退出片尾"
                        className="px-2.5 py-1 text-xs tracking-wider text-[#94a3b8] hover:text-[#f8fafc] rounded border border-white/10 hover:border-white/25 transition-colors"
                    >
                        退出 (Esc)
                    </button>
                </div>
            </div>

            {/* 阶段 1：神秘前导呼吸屏 */}
            {phase === 'intro' && (
                <div className="flex flex-col items-center justify-center space-y-6 text-center">
                    <p
                        className={`text-xl font-light text-[#94a3b8] transition-opacity duration-1000 ${
                            introStep >= 1 ? 'opacity-100' : 'opacity-0'
                        }`}
                    >
                        ……
                    </p>
                    <p
                        className={`text-lg font-light text-[#cbd5e1] transition-opacity duration-1000 ${
                            introStep >= 2 ? 'opacity-100' : 'opacity-0'
                        }`}
                    >
                        等一下。
                    </p>
                    <p
                        className={`text-sm font-light text-[#64748b] transition-opacity duration-1000 ${
                            introStep >= 3 ? 'opacity-100' : 'opacity-0'
                        }`}
                    >
                        好吧。
                    </p>
                </div>
            )}

            {/* 阶段 2：电影片尾滚动正文 */}
            {phase === 'rolling' && (
                <div
                    ref={scrollContainerRef}
                    onWheel={handleUserInteractionStart}
                    onTouchStart={handleUserInteractionStart}
                    onPointerDown={handleUserInteractionStart}
                    onTouchEnd={handleUserInteractionEnd}
                    onWheelCapture={handleUserInteractionEnd}
                    className="w-full h-full overflow-y-auto px-6 md:px-12 scroll-smooth text-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    style={{
                        maskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 85%, transparent 100%)',
                        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 85%, transparent 100%)',
                    }}
                >
                    {/* 顶部留白，让首行文字从视口中央偏下开始缓缓升起 */}
                    <div className="h-[48vh]" />

                    <div className="max-w-2xl mx-auto space-y-24 text-[var(--color-m3-on-surface-variant,#94a3b8)]">
                        {/* 第一幕：你找到这里了 */}
                        <section className="space-y-6">
                            <h1 className="text-2xl md:text-3xl font-medium tracking-[0.25em] text-[#f8fafc]">
                                Kira HRT Tracker
                            </h1>
                            <p className="text-xs md:text-sm font-light tracking-[0.3em] text-[#64748b] uppercase">
                                开源致谢与片尾
                            </p>
                            <div className="h-16" />
                            <p className="text-base font-light text-[#cbd5e1] tracking-widest">
                                你找到这里了。
                            </p>
                            <div className="h-8" />
                            <p className="text-sm font-light text-[#94a3b8]">
                                这里没有什么隐藏功能。
                            </p>
                            <p className="text-sm text-[#475569]">
                                ……
                            </p>
                            <p className="text-xs font-mono text-[#64748b]">
                                大概。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二幕：它曾经不是现在这样 */}
                        <section className="space-y-6">
                            <p className="text-base text-[#cbd5e1] tracking-wide">
                                它以前不是现在这样。
                            </p>
                            <div className="h-12" />
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                那时候，
                            </p>
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                它只是一个运行在浏览器里的网页。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-3 text-xs md:text-sm text-[#64748b]">
                                <p>有像素风。</p>
                                <p>有一只猫。</p>
                                <p>有 Cloudflare Worker。</p>
                                <p>有 D1。</p>
                                <p>有 R2。</p>
                                <p>有 Wrangler。</p>
                                <p>还有一些后来已经不存在的东西。</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#94a3b8]">
                                它们后来都被删掉了。
                            </p>
                            <div className="h-8" />
                            <p className="text-sm text-[#64748b]">
                                不是因为它们不好。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm text-[#cbd5e1]">
                                只是因为项目要去别的地方了。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第三幕：从网页到服务 */}
                        <section className="space-y-6">
                            <div className="space-y-2 text-xs font-mono text-[#ef4444]/80">
                                <p>worker.ts 删除。</p>
                                <p>Cloudflare D1 删除。</p>
                                <p>R2 删除。</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-base font-mono text-[#38bdf8]">
                                server/
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                出现了。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-xs font-mono text-[#94a3b8]/90">
                                <p>Node.js</p>
                                <p>PostgreSQL</p>
                                <p>SQL Schema</p>
                                <p>Application Core</p>
                            </div>
                            <div className="h-6" />
                            <div className="space-y-1.5 text-xs font-mono text-[#64748b]">
                                <p>AccountService</p>
                                <p>MedicationService</p>
                                <p>LabService</p>
                                <p>TimelineService</p>
                                <p>PKSimulationService</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#94a3b8]">
                                前端只是开始。
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                真正复杂的东西，
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                开始藏到服务器后面。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第四幕：它开始学会和 AI 说话 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                然后，
                            </p>
                            <p className="text-base text-[#cbd5e1]">
                                它学会了一件新的事情。
                            </p>
                            <div className="h-8" />
                            <p className="text-lg text-[#38bdf8] font-medium tracking-wide">
                                和 AI 说话。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-xs font-mono text-[#94a3b8]">
                                <p>MCP (Model Context Protocol)</p>
                                <p>Streamable HTTP & stdio</p>
                                <p>Agent Access Token</p>
                                <p>Claude Desktop · Cursor · VS Code</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                它不再只是等待人来点击按钮。
                            </p>
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                在用户授权下，
                            </p>
                            <p className="text-sm leading-relaxed text-[#cbd5e1]">
                                它开始允许其他程序参与记录和查询。
                            </p>
                            <div className="h-12" />
                            <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] max-w-md mx-auto space-y-2">
                                <p className="text-xs text-[#a5b4fc] tracking-wide">
                                    数据猫：
                                </p>
                                <p className="text-sm text-[#cbd5e1] font-light">
                                    「所以现在 AI 也能找到我了？」
                                </p>
                                <div className="h-3" />
                                <p className="text-xs text-[#64748b]">
                                    …… 是的。
                                </p>
                            </div>
                        </section>

                        <div className="h-32" />

                        {/* 第五幕：它开始变得认真 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                但有些事情，
                            </p>
                            <p className="text-sm text-[#94a3b8]">
                                不能因为看起来很漂亮，就把它写进软件。
                            </p>
                            <div className="h-12" />
                            <p className="text-sm leading-relaxed text-[#cbd5e1]">
                                有些药物可以记录。
                            </p>
                            <p className="text-sm leading-relaxed text-[#cbd5e1]">
                                但不是所有药物，都应该被画成一条浓度曲线。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-sm text-[#e2e8f0]">
                                <p>醋酸环丙孕酮</p>
                                <p>螺内酯</p>
                                <p>比卡鲁胺</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-xs font-mono text-[#38bdf8]">
                                记录，可以。
                            </p>
                            <p className="text-xs font-mono text-[#f43f5e]">
                                虚构一个等效浓度，不可以。
                            </p>
                            <div className="h-12" />
                            <div className="grid grid-cols-2 gap-3 text-xs text-[#64748b] max-w-sm mx-auto">
                                <p>泌乳素</p>
                                <p>ALT / AST</p>
                                <p>血钾</p>
                                <p>复查时钟</p>
                                <p>异常警示</p>
                                <p>随访监测</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#94a3b8]">
                                不是为了让页面看起来更专业。
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                是因为这些东西本来就值得被认真记录。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第六幕：记录与解释 */}
                        <section className="space-y-6">
                            <p className="text-base text-[#cbd5e1] tracking-wide">
                                记录一件事情，
                            </p>
                            <p className="text-base text-[#cbd5e1] tracking-wide">
                                和替它下结论，是两回事。
                            </p>
                            <div className="h-12" />
                            <div className="space-y-3 text-sm text-[#94a3b8] leading-relaxed">
                                <p>软件可以帮你保存数据。</p>
                                <p>可以帮你计算。</p>
                                <p>可以帮你提醒。</p>
                                <p>可以帮你整理化验单。</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-sm text-[#f43f5e] font-light">
                                但它不应该假装自己是医生。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第七幕：本地 OCR */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                有时候，
                            </p>
                            <p className="text-sm text-[#94a3b8]">
                                一张纸上有很多数字。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-1 text-sm text-[#cbd5e1]">
                                <p>雌二醇</p>
                                <p>睾酮</p>
                                <p>孕酮</p>
                                <p className="text-xs text-[#64748b]">……</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-sm text-[#94a3b8]">
                                所以让电脑帮忙看一眼。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-xs font-mono text-[#a5b4fc]">
                                <p>本地运行</p>
                                <p>用来预填</p>
                                <p>用户确认之前，不落库</p>
                            </div>
                            <div className="h-12" />
                            <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] max-w-md mx-auto space-y-2">
                                <p className="text-xs text-[#a5b4fc]">
                                    数据猫：
                                </p>
                                <p className="text-sm text-[#cbd5e1] font-light">
                                    「我只负责帮你找数字。」
                                </p>
                                <p className="text-sm text-[#cbd5e1] font-light">
                                    「剩下的，你自己看看。」
                                </p>
                            </div>
                        </section>

                        <div className="h-32" />

                        {/* 第八幕：隐私 */}
                        <section className="space-y-6">
                            <p className="text-base text-[#cbd5e1]">
                                还有一些东西，
                            </p>
                            <p className="text-base text-[#cbd5e1]">
                                不应该被随便看到。
                            </p>
                            <div className="h-10" />
                            <div className="space-y-2 text-xs font-mono text-[#38bdf8]">
                                <p>每条记录</p>
                                <p>独立数据密钥</p>
                                <p>AES-256-GCM</p>
                                <p>Sealed Payload</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-sm text-[#94a3b8]">
                                数据库泄漏，
                            </p>
                            <p className="text-sm text-[#94a3b8]">
                                不应该意味着所有记录一起裸奔。
                            </p>
                            <div className="h-10" />
                            <div className="text-xs text-[#64748b] leading-relaxed max-w-md mx-auto space-y-2">
                                <p>这不是零知识客户端解密。</p>
                                <p>因为服务端仍然需要在用户授权下，</p>
                                <p>为 MCP 提供数据访问能力。</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-sm text-[#f8fafc] tracking-wider">
                                安全不是一句口号。它是边界。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第九幕：七种语言 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                后来，
                            </p>
                            <p className="text-base text-[#cbd5e1]">
                                它开始说不同的语言。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-1.5 text-sm text-[#94a3b8]">
                                <p>简体中文</p>
                                <p>繁体中文</p>
                                <p>粵語</p>
                                <p>English</p>
                                <p>日本語</p>
                                <p>한국어</p>
                                <p>Türkçe</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-sm text-[#94a3b8]">
                                但代码里最害怕的一件事，
                            </p>
                            <p className="text-sm text-[#f43f5e]">
                                还是漏翻译。
                            </p>
                            <div className="h-10" />
                            <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02] max-w-md mx-auto space-y-2">
                                <p className="text-xs font-mono text-[#38bdf8]">
                                    CI：
                                </p>
                                <p className="text-sm text-[#cbd5e1] font-mono">
                                    「没有翻译。拒绝通过。」
                                </p>
                                <div className="h-2" />
                                <p className="text-xs text-[#a5b4fc]">
                                    数据猫：
                                </p>
                                <p className="text-sm text-[#cbd5e1] font-light">
                                    「……好严格。」
                                </p>
                            </div>
                        </section>

                        <div className="h-32" />

                        {/* 第十幕：27 / 27 */}
                        <section className="space-y-6">
                            <p className="text-3xl font-mono font-medium text-[#38bdf8] tracking-widest">
                                27 / 27
                            </p>
                            <p className="text-xs font-mono text-[#64748b]">
                                全部通过。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-1 text-xs font-mono text-[#94a3b8]">
                                <p>PostgreSQL</p>
                                <p>MCP 握手成功</p>
                                <p>服务启动</p>
                                <p>测试通过</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-sm text-[#94a3b8]">
                                可以上线了吗？
                            </p>
                            <p className="text-xs text-[#475569]">
                                ……
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                再测一次。
                            </p>
                            <div className="h-4" />
                            <p className="text-xs font-mono text-[#64748b]">
                                还是 27 / 27。
                            </p>
                            <div className="h-6" />
                            <p className="text-sm text-[#e2e8f0]">
                                好吧。这次真的可以了。
                            </p>
                            <div className="h-4" />
                            <p className="text-xs text-[#a5b4fc]">
                                数据猫：「我批准。」
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十一幕：Bug 博物馆 */}
                        <section className="space-y-6">
                            <h2 className="text-base text-[#cbd5e1] tracking-wider font-medium">
                                这里曾经发生过一些事情。
                            </h2>
                            <div className="h-8" />
                            <div className="space-y-2 text-xs font-mono text-[#64748b]">
                                <p className="text-[#38bdf8]">BUG #001</p>
                                <p>原本只是想改一个地方。</p>
                                <p>最后重写了半个系统。</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-xs text-[#94a3b8]">
                                开发者：
                            </p>
                            <p className="text-sm text-[#cbd5e1] font-light">
                                「我就改一行。」
                            </p>
                            <div className="h-6" />
                            <p className="text-xs text-[#64748b]">
                                三个小时后。
                            </p>
                            <p className="text-xs font-mono text-[#f8fafc]">
                                git diff
                            </p>
                            <div className="h-4" />
                            <div className="flex items-center justify-center gap-6 text-sm font-mono">
                                <span className="text-[#22c55e]">+39,258</span>
                                <span className="text-[#ef4444]">-13,666</span>
                            </div>
                            <div className="h-10" />
                            <p className="text-sm text-[#94a3b8]">
                                很多东西被删掉了。
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                很多东西重新长出来了。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十二幕：项目大重写 */}
                        <section className="space-y-6">
                            <div className="space-y-2 text-xs md:text-sm text-[#94a3b8]/80 leading-loose">
                                <p>前端重写。</p>
                                <p>后端重写。</p>
                                <p>数据层重写。</p>
                                <p>账户系统重写。</p>
                                <p>同步系统重写。</p>
                                <p>MCP 加入。</p>
                                <p>隐私架构重构。</p>
                                <p>医学逻辑重构。</p>
                                <p>UI 重构。</p>
                                <p>多语言重构。</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#cbd5e1]">
                                很多东西消失了。
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                很多东西出现了。
                            </p>
                            <div className="h-8" />
                            <p className="text-sm text-[#64748b]">
                                那只原来的像素猫，
                            </p>
                            <p className="text-sm text-[#64748b]">
                                也没有留下来。
                            </p>
                            <div className="h-12" />
                            <p className="text-base text-[#f8fafc] font-medium tracking-wide">
                                但有一样东西没有被重写。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十三幕：没有被重写的东西 */}
                        <section className="space-y-6">
                            <p className="text-2xl font-light tracking-[0.2em] text-[#38bdf8]">
                                数学。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-sm text-[#cbd5e1]">
                                <p>三室开放模型</p>
                                <p>双相肌注吸收动力学</p>
                                <p>舌下含服模型</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#94a3b8]">
                                这些方程，有自己的来处。
                            </p>
                            <div className="h-6" />
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                它们不是我们第一次写下的。
                            </p>
                            <p className="text-sm leading-relaxed text-[#cbd5e1]">
                                我们只是把它们，带到了一个新的项目里。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十四幕：给上游作者 */}
                        <section className="space-y-6">
                            <p className="text-base text-[#cbd5e1]">
                                还有一件事。
                            </p>
                            <div className="h-8" />
                            <p className="text-sm text-[#94a3b8]">
                                在复用这部分工作之前，我们联系了原作者。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm text-[#cbd5e1]">
                                对方回复了。
                            </p>
                            <div className="h-6" />
                            <p className="text-lg text-[#22c55e] font-medium tracking-widest">
                                可以。
                            </p>
                            <div className="h-12" />
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                很多时候，开源并不是什么宏大的东西。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm leading-relaxed text-[#94a3b8]">
                                它可能只是一个开发者，回复了另一个开发者的一封消息。
                            </p>
                            <div className="h-8" />
                            <p className="text-sm leading-relaxed text-[#cbd5e1]">
                                然后，一份已经存在的工作，又开始了下一段旅程。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十五幕：真正的开源致谢 */}
                        <section className="space-y-12">
                            <h2 className="text-base font-medium text-[#f8fafc] tracking-widest uppercase">
                                演职员表与开源基石
                            </h2>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">药代动力学模型</p>
                                <p className="text-sm text-[#e2e8f0]">HRT-Recorder-PKcomponent-Test</p>
                                <p className="text-xs text-[#64748b]">作者：Mihari (@LaoZhong-Mihari) · 非商业非独占授权许可</p>
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">上游基础网页</p>
                                <p className="text-sm text-[#e2e8f0]">Oyama&apos;s HRT Tracker</p>
                                <p className="text-xs text-[#64748b]">作者：Joseph Smirnova Oyama (@xunxunProjects) · MIT License</p>
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">存储引擎与数据库</p>
                                <p className="text-sm text-[#e2e8f0]">PostgreSQL · node-postgres (pg)</p>
                                <p className="text-xs text-[#64748b]">PostgreSQL Global Development Group · PostgreSQL License</p>
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">服务端与运行环境</p>
                                <p className="text-sm text-[#e2e8f0]">Node.js 原生底层 HTTP 驱动</p>
                                <p className="text-xs text-[#64748b]">Node.js Contributors · MIT License</p>
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">智能体上下文协议</p>
                                <p className="text-sm text-[#e2e8f0]">Model Context Protocol SDK (@modelcontextprotocol/sdk)</p>
                                <p className="text-xs text-[#64748b]">Anthropic PBC · MIT License</p>
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">边缘与离线 OCR 识别</p>
                                <p className="text-sm text-[#e2e8f0]">Tesseract.js</p>
                                <p className="text-xs text-[#64748b]">Tesseract OCR Engine · Apache 2.0 License</p>
                            </div>

                            <div className="space-y-3">
                                <p className="text-xs font-mono text-[#38bdf8]">前端构建与交互系统</p>
                                <p className="text-sm text-[#e2e8f0]">React · Vite · Tailwind CSS · Reicon · jsPDF</p>
                                <p className="text-xs text-[#64748b]">Material Design 3 规范与设计令牌实现</p>
                            </div>
                        </section>

                        <div className="h-32" />

                        {/* 第十六幕：从一个项目到另一个项目 */}
                        <section className="space-y-6">
                            <div className="text-sm font-mono text-[#94a3b8] space-y-1">
                                <p>Oyama&apos;s HRT Tracker</p>
                                <p className="text-[#38bdf8]">↓</p>
                                <p className="text-[#f8fafc]">Kira HRT Tracker</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-sm text-[#94a3b8]">
                                不是简单复制。
                            </p>
                            <p className="text-sm text-[#94a3b8]">
                                也不是从零开始。
                            </p>
                            <p className="text-sm text-[#cbd5e1]">
                                是从一个已经存在的东西，继续往前走。
                            </p>
                            <div className="h-10" />
                            <div className="text-xs md:text-sm text-[#64748b] leading-relaxed space-y-2 max-w-lg mx-auto">
                                <p>原项目留下了起点。</p>
                                <p>Kira HRT Tracker 重写了大量架构、服务端、界面与功能。</p>
                                <p>但那些继续被使用的底层工作，仍然属于它们原来的来处。</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-sm text-[#f8fafc]">
                                所以我们把名字留下来。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十七幕：从代码到人 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                一开始，
                            </p>
                            <p className="text-sm text-[#94a3b8]">
                                它只是一个记录用药的小工具。
                            </p>
                            <div className="h-6" />
                            <div className="space-y-1 text-xs font-mono text-[#64748b]">
                                <p>一支药。</p>
                                <p>一个时间。</p>
                                <p>一次化验。</p>
                                <p>一条曲线。</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-sm text-[#94a3b8]">
                                后来它变得复杂。
                            </p>
                            <div className="h-8" />
                            <p className="text-sm text-[#cbd5e1]">
                                但这些东西，最后还是在记录同一件事情。
                            </p>
                            <div className="h-6" />
                            <p className="text-xl md:text-2xl font-light text-[#f8fafc] tracking-widest">
                                一个人的生活。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第十八幕：那些记录之外的人 */}
                        <section className="space-y-8">
                            <p className="text-sm text-[#cbd5e1] leading-relaxed">
                                有人在第一次打开 HRT 记录器。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm text-[#cbd5e1] leading-relaxed">
                                有人在第一次认真记录自己的身体。
                            </p>
                            <div className="h-4" />
                            <div className="space-y-1 text-sm text-[#94a3b8] leading-relaxed">
                                <p>有人在医院走廊里，</p>
                                <p>攥着一张化验单。</p>
                            </div>
                            <div className="h-4" />
                            <div className="space-y-1 text-sm text-[#94a3b8] leading-relaxed">
                                <p>有人在凌晨，</p>
                                <p>搜索一个自己已经看过很多遍的问题。</p>
                            </div>
                            <div className="h-6" />
                            <div className="space-y-1 text-sm text-[#cbd5e1] leading-relaxed">
                                <p>有人第一次认真问自己：</p>
                                <p className="text-[#f8fafc]">「我是不是也可以这样生活？」</p>
                            </div>
                            <div className="h-12" />
                            <div className="space-y-2 text-xs md:text-sm text-[#64748b] leading-relaxed">
                                <p>他们可能互不认识。</p>
                                <p>生活也许完全不同。</p>
                                <p>但他们都曾经在某个地方，找到过彼此。</p>
                            </div>
                        </section>

                        <div className="h-32" />

                        {/* 第十九幕：什么叫“记录” */}
                        <section className="space-y-8">
                            <p className="text-sm text-[#94a3b8]">
                                看起来，这些都只是数据。
                            </p>
                            <div className="h-6" />
                            <p className="text-base text-[#cbd5e1]">
                                可数据的后面，总是有人。
                            </p>
                            <div className="h-10" />
                            <div className="space-y-4 text-sm text-[#94a3b8] leading-relaxed max-w-md mx-auto">
                                <p>一项化验结果后面，有一个正在生活的人。</p>
                                <p>一次用药记录后面，有一个正在摸索自己身体的人。</p>
                                <p>一份调查问卷后面，也从来不只是一个统计数字。</p>
                                <p className="text-[#cbd5e1]">它后面，是一个真的填写过答案的人。</p>
                            </div>
                            <div className="h-12" />
                            <div className="space-y-2 text-sm text-[#94a3b8]">
                                <p>所以，我们记录的从来不只是激素。</p>
                                <p>也不只是数字。</p>
                                <p>更不是一张漂亮的曲线。</p>
                            </div>
                            <div className="h-10" />
                            <p className="text-lg md:text-xl font-medium text-[#f8fafc] tracking-widest leading-relaxed">
                                我们记录的，是一些人正在成为自己。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十幕：跨性别人文关怀 */}
                        <section className="space-y-4 text-sm text-[#cbd5e1] leading-loose max-w-md mx-auto">
                            <p>一次认真听完的话。</p>
                            <p>一次不被打断的自我介绍。</p>
                            <p>一个被正确称呼的名字。</p>
                            <p>一份不会因为害怕而藏起来的病历。</p>
                            <p>一间可以放心进去的诊室。</p>
                            <p>一个知道自己并不孤单的晚上。</p>
                            <div className="h-16" />
                            <p className="text-sm text-[#94a3b8]">
                                有时候，所谓“关怀”并不是什么巨大的事情。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm text-[#f8fafc]">
                                只是有人愿意认真对待另一个人的存在。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十一幕：从社区回到开源 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                或许开源也是这样。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-sm text-[#cbd5e1]">
                                <p>有人把自己做过的东西留下来。</p>
                                <p>后来的人，接住它。</p>
                                <p className="text-[#64748b]">改一改。补一点。修一个问题。再留下去。</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#94a3b8] leading-relaxed">
                                于是，一个人写下的东西，变成了很多人可以继续使用的东西。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-1 text-xs font-mono text-[#a5b4fc]">
                                <p>代码如此。</p>
                                <p>知识如此。</p>
                                <p>经验如此。</p>
                                <p className="text-[#f8fafc]">关怀，也应该如此。</p>
                            </div>
                        </section>

                        <div className="h-32" />

                        {/* 第二十二幕：没有漂亮答案 */}
                        <section className="space-y-6">
                            <p className="text-base text-[#cbd5e1]">
                                我们不追求制造一个漂亮的答案。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-sm text-[#94a3b8]">
                                <p>我们更希望留下：</p>
                                <p className="text-[#f8fafc]">足够可靠的问题。</p>
                                <p className="text-[#f8fafc]">足够诚实的证据。</p>
                                <p className="text-[#f8fafc]">足够长久的记录。</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm leading-relaxed text-[#cbd5e1] max-w-md mx-auto">
                                因为一个真实的问题，有时候比一个漂亮的答案，更值得被留下。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十三幕：后来的人 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                也许某一天，这个项目会被另一个人接着修改。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm text-[#94a3b8]">
                                也许某一天，会有人发现我们今天写下的东西，其实也可以做得更好。
                            </p>
                            <div className="h-8" />
                            <p className="text-base text-[#22c55e]">
                                那很好。
                            </p>
                            <div className="h-10" />
                            <p className="text-sm text-[#94a3b8]">
                                因为留下东西，从来不是为了让它永远属于自己。
                            </p>
                            <div className="h-4" />
                            <p className="text-sm text-[#cbd5e1] leading-relaxed">
                                而是希望它在自己离开之后，还能稍微帮到一个人。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十四幕：最终高潮 */}
                        <section className="space-y-4 text-sm text-[#cbd5e1] leading-loose max-w-md mx-auto">
                            <p>有人写出了算法。</p>
                            <p>有人公开了代码。</p>
                            <p>有人维护了依赖。</p>
                            <p>有人认真写了文档。</p>
                            <p>有人把服务器跑了起来。</p>
                            <p>有人发现问题。</p>
                            <p>有人修掉问题。</p>
                            <p>有人回答了一封邮件。</p>
                            <p>有人继续往下写。</p>
                            <div className="h-16" />
                            <p className="text-sm text-[#94a3b8]">
                                我们只是把这些东西，接到了一起。
                            </p>
                            <div className="h-8" />
                            <p className="text-xl md:text-2xl font-light text-[#f8fafc] tracking-[0.2em]">
                                于是，Kira HRT Tracker 出现了。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十五幕：最后的感谢 */}
                        <section className="space-y-4 text-sm text-[#94a3b8] leading-loose max-w-md mx-auto">
                            <p>感谢写下代码的人。</p>
                            <p>感谢分享知识的人。</p>
                            <p>感谢维护开源项目的人。</p>
                            <p>感谢认真填写问卷的人。</p>
                            <p>感谢愿意讲述自己经历的人。</p>
                            <p>感谢那个在陌生人的问题下面，认真写下回答的人。</p>
                            <div className="h-16" />
                            <p className="text-sm text-[#f8fafc] leading-relaxed">
                                也感谢每一个，让另一个人稍微觉得世界没那么冷的人。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十六幕：愿你有一天 */}
                        <section className="space-y-6 max-w-md mx-auto">
                            <p className="text-sm text-[#94a3b8]">
                                如果有一天，
                            </p>
                            <div className="h-4" />
                            <div className="space-y-1 text-sm text-[#cbd5e1] leading-relaxed">
                                <p>那些今天还需要一遍又一遍证明自己</p>
                                <p className="text-[#f8fafc]">“确实经历过”</p>
                                <p>的人，不再需要证明了。</p>
                            </div>
                            <div className="h-8" />
                            <div className="space-y-1 text-sm text-[#cbd5e1] leading-relaxed">
                                <p>如果有一天，</p>
                                <p>一个人只是很平静地生活，</p>
                                <p>而不必先向这个世界解释，</p>
                                <p className="text-[#f8fafc]">自己为什么值得被认真对待。</p>
                            </div>
                            <div className="h-12" />
                            <p className="text-sm text-[#94a3b8]">
                                那大概，就是这些记录最终能够去到的地方。
                            </p>
                            <div className="h-6" />
                            <p className="text-xs text-[#64748b]">
                                不是答案。只是让下一次提问，拥有更多真实的东西。
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十七幕：给正在寻找自己的人 */}
                        <section className="space-y-6">
                            <p className="text-sm text-[#94a3b8]">
                                愿每一个正在寻找自己的人，
                            </p>
                            <p className="text-base text-[#cbd5e1]">
                                都能找到一点可以依靠的东西。
                            </p>
                            <div className="h-8" />
                            <div className="space-y-2 text-sm text-[#94a3b8]">
                                <p>一份资料。</p>
                                <p>一个社区。</p>
                                <p>一位愿意认真听你说话的人。</p>
                                <div className="h-4" />
                                <p className="text-xs text-[#64748b]">或者，</p>
                                <p className="text-sm text-[#cbd5e1]">一只愿意安静陪着你的数据猫。</p>
                            </div>
                            <div className="h-8" />
                            <p className="text-2xl">
                                🐈
                            </p>
                        </section>

                        <div className="h-32" />

                        {/* 第二十八幕：最后的电波 */}
                        <section className="space-y-6">
                            <p className="text-xs text-[#475569]">
                                ……
                            </p>
                            <div className="h-6" />
                            <div className="p-5 rounded-2xl border border-white/5 bg-white/[0.015] max-w-sm mx-auto space-y-4">
                                <p className="text-xs text-[#a5b4fc]">
                                    数据猫：
                                </p>
                                <p className="text-sm text-[#cbd5e1] font-light leading-relaxed">
                                    「所以我们到底在记录什么？」
                                </p>
                                <div className="h-8" />
                                <p className="text-xs text-[#64748b]">
                                    ……
                                </p>
                                <div className="h-4" />
                                <p className="text-sm text-[#cbd5e1] font-light">
                                    「嗯。」
                                </p>
                                <p className="text-sm text-[#f8fafc] font-light">
                                    「先记录下来吧。」
                                </p>
                                <div className="h-4" />
                                <p className="text-lg">
                                    🐈
                                </p>
                            </div>
                        </section>

                        <div className="h-48" />

                        {/* 终章一句与余韵 */}
                        <section className="space-y-8">
                            <h3 className="text-2xl md:text-3xl font-light tracking-[0.25em] text-[#f8fafc]">
                                Kira HRT Tracker
                            </h3>
                            <div className="space-y-3 text-sm md:text-base font-light tracking-widest text-[#cbd5e1]">
                                <p>记录身体，</p>
                                <p>也记得人。</p>
                            </div>
                            <div className="h-16" />
                            <p className="text-base md:text-lg font-light tracking-[0.2em] text-[#f8fafc] max-w-md mx-auto leading-relaxed">
                                愿你有一天，
                                <br />
                                可以很平静地成为自己。
                            </p>
                        </section>

                        <div className="h-48" />

                        {/* 尾声：安静的离开 */}
                        <section className="space-y-6 pb-24">
                            <p className="text-xs font-light tracking-widest text-[#64748b]">
                                感谢你看到这里。
                            </p>
                            <div className="pt-2">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="inline-flex items-center gap-1.5 text-xs text-[#38bdf8] hover:underline tracking-wider"
                                >
                                    <span>查看完整开源许可证与致谢</span>
                                    <span>→</span>
                                </button>
                            </div>
                            <div className="pt-6">
                                <span className="text-xl opacity-75">🐈</span>
                            </div>
                        </section>
                    </div>

                    {/* 底部缓冲高位，确保最后一行能滚动到屏幕视口正中 */}
                    <div className="h-[40vh]" />
                </div>
            )}
        </div>
    );
};
