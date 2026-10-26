import { ChatShell } from "@/components/chat-shell";
import { InteractionProvider } from "@/components/motion-provider";
export default function Home() { return <InteractionProvider><ChatShell /></InteractionProvider>; }
