import { memo, useRef, useEffect } from "react";
import { Crown, Loader2, User } from "lucide-react";
import type { AgentSlot, GroupMessage, GroupSessionStatus } from "@/types/groups";

interface GroupChatProps {
  messages: GroupMessage[];
  slots: AgentSlot[];
  status: GroupSessionStatus;
}

export const GroupChat = memo(function GroupChat({ messages, slots, status }: GroupChatProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const slotMap = new Map(slots.map((s) => [s.id, s]));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
        <Users2 className="h-8 w-8 opacity-30" />
        <p className="text-sm">Send a prompt to start a group debate</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {messages.map((msg) => {
        const slot = slotMap.get(msg.slotId);
        const isUser = msg.role === "user";

        return (
          <div key={msg.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              {isUser ? (
                <>
                  <User className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[11px] font-medium text-muted-foreground">You</span>
                </>
              ) : slot ? (
                <>
                  <div
                    className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
                    style={{ backgroundColor: slot.color }}
                  >
                    {slot.label[0].toUpperCase()}
                  </div>
                  <span className="text-[11px] font-medium" style={{ color: slot.color }}>
                    {slot.label}
                  </span>
                  {slot.role === "leader" && (
                    <Crown className="h-2.5 w-2.5 text-amber-400" />
                  )}
                  <span className="text-[10px] text-muted-foreground/60">
                    {slot.engine}/{slot.model}
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">System</span>
              )}
              <span className="ms-auto text-[10px] text-muted-foreground/40">
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <div
              className={`rounded-lg px-3 py-2 text-sm wrap-break-word ${
                isUser
                  ? "bg-foreground/[0.04]"
                  : "border border-foreground/5 bg-background"
              }`}
              style={
                !isUser && slot
                  ? { borderLeftColor: slot.color, borderLeftWidth: 2 }
                  : undefined
              }
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        );
      })}

      {(status === "running" || status === "waiting-leader") && (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {status === "waiting-leader" ? "Leader is synthesizing..." : "Agents are responding..."}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
});

function Users2(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M14 19a6 6 0 0 0-12 0" />
      <circle cx="8" cy="9" r="4" />
      <path d="M22 19a6 6 0 0 0-6-6 4 4 0 1 0 0-8" />
    </svg>
  );
}
