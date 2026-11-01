import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Form, Input, Tabs } from "antd";
import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { WorkspaceErrorState } from "@/components/layout/workspace-state";
import { WorkspaceBootstrapHydrator } from "@/components/workspace/workspace-bootstrap-hydrator";
import { ApiError } from "@/services/api/request";
import type { WorkspaceBootstrapPayload } from "@/services/api/workspace";
import { appQueryClient } from "@/lib/query-client";
import { hub, setHubSession, type HubSession } from "./api";

const HubContext = createContext<HubSession>({ enabled: false, authenticated: false });
export function useHubSession() { return useContext(HubContext); }

export function accountBootstrap(payload: WorkspaceBootstrapPayload, session: HubSession): WorkspaceBootstrapPayload {
    if (!session.enabled) return payload;
    if (!session.authenticated || !session.scope || !session.user) throw new Error("账号会话无效");
    return { ...payload, workspace: { ...payload.workspace, id: session.scope }, user: { ...payload.user, username: session.user.username, displayName: session.user.display_name || session.user.username } };
}

export function IntegrationGate({ children, localChildren }: { children: ReactNode; localChildren?: ReactNode }) {
    const [session, setSession] = useState<HubSession>();
    const [failed, setFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let cancelled = false;
        let retryTimer = 0;
        void hub.session().then((value) => { if (!cancelled) { setHubSession(value.session); setSession(value); } }).catch((error) => {
            if (cancelled) return;
            // Only an explicit missing integration endpoint enables the
            // official local mode. Network/auth failures must never log in.
            if (error instanceof ApiError && error.status === 404) setSession({ enabled: false, authenticated: false });
            else if (import.meta.env.DEV) retryTimer = window.setTimeout(() => setRetry((value) => value + 1), 1_000);
            else setFailed(true);
        });
        return () => { cancelled = true; window.clearTimeout(retryTimer); };
    }, [retry]);
    if (failed) return <WorkspaceErrorState title="无法连接工作台" description="登录服务暂时不可用，请检查后端连接后重试。" onRetry={() => { setFailed(false); setSession(undefined); setRetry((value) => value + 1); }} />;
    if (!session) return <FullScreenLoader label="正在连接工作台" detail={import.meta.env.DEV && retry > 0 ? "等待本地后端完成编译" : "检查账号会话"} />;
    if (session.enabled && !session.authenticated) return <Login onLogin={(value) => { appQueryClient.clear(); setHubSession(value.session); setSession(value); }} />;
    return <HubContext.Provider value={session}>
        {!session.enabled && localChildren ? localChildren : <WorkspaceBootstrapHydrator allowLocalFallback={!session.enabled} transformBootstrap={(payload) => accountBootstrap(payload, session)}>{children}</WorkspaceBootstrapHydrator>}
    </HubContext.Provider>;
}

function Login({ onLogin }: { onLogin: (session: HubSession) => void }) {
    const [mode, setMode] = useState("login");
    const [busy, setBusy] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [form] = Form.useForm();
    const submit = async (values: { username: string; password: string; email: string; verification_code?: string; aff_code?: string }) => {
        setBusy(true); setError(""); setNotice("");
        try {
            if (mode === "register") { await hub.register(values); setNotice("注册成功，请登录"); setMode("login"); form.setFieldValue("password", ""); }
            else { const value = await hub.login(values.username, values.password); if (!value.authenticated || !value.session) throw new Error("登录会话无效"); form.resetFields(); onLogin(value); }
        } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试"); }
        finally { setBusy(false); }
    };
    return <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
        <section className="w-full max-w-md rounded-[var(--r-lg)] border border-border bg-surface p-8">
            <h1 className="text-2xl font-semibold">BeefTV · aihubkit</h1>
            <p className="mb-5 mt-2 text-sm text-foreground/60">登录后进入创作工作台，素材按需上传，无需配置存储桶。</p>
            <Tabs activeKey={mode} onChange={(key) => { setMode(key); setError(""); }} items={[{ key: "login", label: "登录" }, { key: "register", label: "注册" }]} />
            {error && <Alert className="mb-4" type="error" showIcon title={error} />}
            {notice && <Alert className="mb-4" type="success" showIcon title={notice} />}
            <Form form={form} layout="vertical" onFinish={submit} disabled={busy} requiredMark={false}>
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}><Input autoComplete="username" /></Form.Item>
                {mode === "register" && <>
                    <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}><Input autoComplete="email" /></Form.Item>
                    <Form.Item label="邮箱验证码"><div className="flex gap-2"><Form.Item name="verification_code" noStyle><Input autoComplete="one-time-code" /></Form.Item><Button loading={sending} onClick={async () => {
                        try { await form.validateFields(["email"]); setSending(true); setError(""); await hub.verification(form.getFieldValue("email")); setNotice("验证码已发送，请查收邮箱"); }
                        catch (cause) { if (cause instanceof Error) setError(cause.message); }
                        finally { setSending(false); }
                    }}>发送验证码</Button></div></Form.Item>
                </>}
                <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}><Input.Password autoComplete={mode === "register" ? "new-password" : "current-password"} /></Form.Item>
                <Button block type="primary" htmlType="submit" loading={busy}>{mode === "register" ? "创建账号" : "登录并打开工作台"}</Button>
            </Form>
        </section>
    </main>;
}
