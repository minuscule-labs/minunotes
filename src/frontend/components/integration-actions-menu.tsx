import { type ComponentProps, type ReactNode, useRef, useState } from 'react';
import { ApiKeyAccessDialog } from './api-key-access-dialog';
import { DeleteConfirmDialog } from './delete-confirm-dialog';
import { ActionMenuButton, ActionMenuIconButton } from './ui/action-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

type ConfirmationAction = Pick<
  ComponentProps<typeof DeleteConfirmDialog>,
  'label' | 'heading' | 'warning' | 'actionLabel' | 'requiresTypedConfirmation' | 'onConfirm'
> & { id: string };

type AccessSettings = Omit<ComponentProps<typeof ApiKeyAccessDialog>, 'trigger' | 'open' | 'onOpenChange'>;

export function IntegrationActionsMenu({
  label,
  access,
  actions,
  details,
}: {
  label: string;
  access?: AccessSettings;
  actions: ConfirmationAction[];
  details?: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationAction | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const accessWasOpen = useRef(false);
  const changeAccessOpen = (open: boolean) => {
    setAccessOpen(open);
    if (!open && accessWasOpen.current) window.requestAnimationFrame(() => triggerRef.current?.focus());
    accessWasOpen.current = open;
  };

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild ref={triggerRef}>
          <ActionMenuIconButton aria-label={label} />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-1">
          {access ? (
            <ActionMenuButton
              onClick={() => {
                setMenuOpen(false);
                changeAccessOpen(true);
              }}
            >
              Edit access
            </ActionMenuButton>
          ) : null}
          {actions.map((action) => (
            <ActionMenuButton
              key={action.id}
              destructive
              onClick={() => {
                setMenuOpen(false);
                setConfirmation(action);
              }}
            >
              {action.actionLabel}
            </ActionMenuButton>
          ))}
          {details ? <div className="border-[var(--notes-border)] border-t p-2">{details}</div> : null}
        </PopoverContent>
      </Popover>
      {access ? <ApiKeyAccessDialog {...access} open={accessOpen} onOpenChange={changeAccessOpen} /> : null}
      {confirmation ? (
        <DeleteConfirmDialog
          {...confirmation}
          open
          hideTrigger
          returnFocusRef={triggerRef}
          onOpenChange={(open) => {
            if (!open) setConfirmation(null);
          }}
        />
      ) : null}
    </>
  );
}
