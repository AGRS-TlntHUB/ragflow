import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogNode,
} from '@/components/confirm-delete-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDeleteAgent, useDuplicateAgent } from '@/hooks/use-agent-request';
import { IFlow } from '@/interfaces/database/agent';
import { Copy, PenLine, Trash2 } from 'lucide-react';
import { MouseEventHandler, PropsWithChildren, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRenameAgent } from './use-rename-agent';

export function AgentDropdown({
  children,
  showAgentRenameModal,
  agent: agent,
}: PropsWithChildren &
  Pick<ReturnType<typeof useRenameAgent>, 'showAgentRenameModal'> & {
    agent: IFlow;
  }) {
  const { t } = useTranslation();
  const { deleteAgent } = useDeleteAgent();
  const { duplicateAgent } = useDuplicateAgent();

  const handleShowAgentRenameModal: MouseEventHandler<HTMLDivElement> =
    useCallback(
      (e) => {
        e.stopPropagation();
        showAgentRenameModal(agent);
      },
      [agent, showAgentRenameModal],
    );

  const handleDelete: MouseEventHandler<HTMLDivElement> = useCallback(() => {
    deleteAgent([agent.id]);
  }, [agent.id, deleteAgent]);

  const handleDuplicate: MouseEventHandler<HTMLDivElement> = useCallback(
    (e) => {
      e.stopPropagation();
      duplicateAgent(agent.id);
    },
    [agent.id, duplicateAgent],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={handleShowAgentRenameModal}>
          {t('common.rename')} <PenLine />
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleDuplicate}>
          {t('common.duplicate')} <Copy />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ConfirmDeleteDialog
          onOk={handleDelete}
          title={t('deleteModal.delAgent')}
          content={{
            node: (
              <ConfirmDeleteDialogNode
                avatar={{ avatar: agent.avatar, name: agent.title }}
                name={agent.title}
              />
            ),
          }}
        >
          <DropdownMenuItem
            className="text-state-error"
            onSelect={(e) => {
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {t('common.delete')} <Trash2 />
          </DropdownMenuItem>
        </ConfirmDeleteDialog>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
