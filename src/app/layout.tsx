import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "PRBOT · Codex 工作台", description: "在本机与 Codex 对话，让想法变成代码。", icons: { icon: "/prbot.svg", apple: "/prbot.png" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
