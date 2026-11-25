import Link from "next/link";
import { Card } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card className="p-8 text-center">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          This page doesn&apos;t exist or you don&apos;t have access to it.
        </p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400">
          Go to dashboard
        </Link>
      </Card>
    </div>
  );
}
