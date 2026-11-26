import ForgotPasswordForm from "./ForgotPasswordForm";
export default function ForgotPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/logo.svg" alt="MetricFlock" width={48} height={48} className="rounded-xl" />
          <h1 className="text-xl font-bold">Reset your password</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">We&apos;ll email you a one-time reset link.</p>
        </div>
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
