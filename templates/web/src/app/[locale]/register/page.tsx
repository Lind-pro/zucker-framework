"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { httpClient } from "@/lib/http-client";

export default function RegisterPage() {
  const t = useTranslations("auth");
  const router = useRouter();

  const [form, setForm] = useState({ username: "", email: "", password: "", confirmPassword: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleChange = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setLoading(true);
    try {
      await httpClient.post("/users", {
        username: form.username,
        email: form.email,
        password: form.password,
      });
      router.push("/login");
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6">
      <div className="w-full max-w-md p-8 rounded-xl bg-[var(--color-card)] border border-[var(--color-border)]">
        <h1 className="text-2xl font-bold mb-2">{t("registerTitle")}</h1>
        <p className="text-[var(--color-muted)] mb-8">{t("registerDescription")}</p>

        <form className="space-y-4" onSubmit={handleSubmit}>
          {(["username", "email", "password", "confirmPassword"] as const).map((field) => (
            <div key={field}>
              <label className="block text-sm font-medium mb-1.5">{t(field)}</label>
              <input
                type={field.toLowerCase().includes("password") ? "password" : field === "email" ? "email" : "text"}
                value={form[field]}
                onChange={handleChange(field)}
                required
                className="w-full px-4 py-2.5 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          ))}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 text-white py-2.5 rounded-lg font-medium transition-colors"
          >
            {loading ? "注册中..." : t("registerButton")}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-muted)]">
          {t("hasAccount")}{" "}
          <Link href="/login" className="text-primary-500 hover:text-primary-400">
            {t("goLogin")}
          </Link>
        </p>
      </div>
    </div>
  );
}
