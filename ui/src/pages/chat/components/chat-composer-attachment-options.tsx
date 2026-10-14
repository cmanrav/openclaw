import { For } from "solid-js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { useSingleAttachmentPicker } from "./chat-attachment-picker-policy.ts";
import { LitContent } from "./chat-composer-interop.tsx";

// The trigger and item hosts stay direct children of Web Awesome's slot owner.
export function renderAttachmentOptions() {
  const entries = useSingleAttachmentPicker()
    ? [{ value: "file", icon: icons.paperclip, label: t("chat.composer.attach") }]
    : [
        { value: "camera", icon: icons.camera, label: t("chat.composer.takePhoto") },
        { value: "photo", icon: icons.image, label: t("chat.composer.attachPhoto") },
        { value: "file", icon: icons.paperclip, label: t("chat.composer.attachFileOption") },
      ];
  return (
    <For keyed={(item) => item} each={entries}>
      {(entry) => (
        <wa-dropdown-item class="agent-chat__attach-menu-option" value={entry().value}>
          <span slot="icon" aria-hidden="true">
            <LitContent value={entry().icon} />
          </span>
          <span>{entry().label}</span>
        </wa-dropdown-item>
      )}
    </For>
  );
}
