"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { useAuthStore } from "@/lib/stores/auth-store";
import { httpClient } from "@/lib/http-client";

interface LoginResult {
  userId: string;
  token: string;
  expires?: number;
}

interface MePermission {
  id: string;
  actions: string[];
}

interface MeResult {
  id: string;
  username: string;
  name?: string;
  permissions: MePermission[];
  attributes?: Record<string, unknown>;
}

export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuthState } = useAuthStore();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const loginResult = await httpClient.post<LoginResult>("/authorize/login", {
        username,
        password,
      });

      const meResult = await httpClient.get<MeResult>("/authorize/me", undefined, {
        headers: { Authorization: `Bearer ${loginResult.token}` },
      });

      const permissions = meResult.permissions.flatMap((p) =>
        p.actions.map((a) => `${p.id}:${a}`),
      );

      setAuthState({
        token: loginResult.token,
        user: { id: meResult.id, username: meResult.username, name: meResult.name },
        permissions,
      });

      // 将 token 写入 cookie 供 middleware 路由守卫读取
      const maxAge = loginResult.expires && loginResult.expires > 0
        ? Math.floor(loginResult.expires / 1000)
        : 86400;
      const secure = location.protocol === "https:" ? "; Secure" : "";
      document.cookie = `auth-token=${loginResult.token}; Max-Age=${maxAge}; path=/; SameSite=Strict${secure}`;

      const raw = searchParams.get("redirect") || "/dashboard";
      const redirect = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
      router.push(redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6">
      <div className="w-full max-w-md p-8 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)]">
        <h1 className="text-2xl font-bold mb-2">{t("loginTitle")}</h1>
        <p className="text-[var(--color-muted)] mb-8">{t("loginDescription")}</p>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm font-medium mb-1.5">{t("username")}</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">{t("password")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}

          <div className="flex items-center justify-between text-sm">
            <span />
            <a href="#" className="text-primary-500 hover:text-primary-400">
              {t("forgotPassword")}
            </a>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white py-2.5 rounded-lg font-medium transition-colors"
          >
            {loading ? "登录中..." : t("loginButton")}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-muted)]">
          {t("noAccount")}{" "}
          <Link href="/register" className="text-primary-500 hover:text-primary-400">
            {t("goRegister")}
          </Link>
        </p>
      </div>
    </div>
  );
}
