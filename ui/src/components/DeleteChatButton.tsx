import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface DeleteChatButtonProps {
  agentName: string;
  /** Names of documents on the conversation; the delete removes them too. */
  documentNames?: string[];
  onDelete: () => void | Promise<void>;
  pending?: boolean;
}

/** Confirmed, permanent delete of the current agent conversation. */
export function DeleteChatButton({
  agentName,
  documentNames = [],
  onDelete,
  pending,
}: DeleteChatButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete chat with ${agentName}`}
        title="Delete chat"
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes your conversation with {agentName}. This
            cannot be undone.
          </AlertDialogDescription>
          {documentNames.length > 0 ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              It also deletes {documentNames.length === 1 ? "this document" : `these ${documentNames.length} documents`}:{" "}
              {documentNames.join(", ")}. Move them to another task first if
              you need them.
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={async () => {
              await onDelete();
              setOpen(false);
            }}
          >
            Delete chat
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
