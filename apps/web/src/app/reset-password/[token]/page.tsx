import ResetPasswordForm from "./ResetPasswordForm";
// better-auth emails reset links as {baseURL}/reset-password/{token}.
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/logo.svg" alt="MetricFlock" width={48} height={48} className="rounded-xl" />
          <h1 className="text-xl font-bold">Choose a new password</h1>
        </div>
        <ResetPasswordForm token={token} />
      </div>
    </div>
  );
}
