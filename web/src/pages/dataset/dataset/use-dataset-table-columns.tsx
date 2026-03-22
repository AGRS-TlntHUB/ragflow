import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { FileIcon } from '@/components/icon-font';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import message from '@/components/ui/message';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useNavigatePage } from '@/hooks/logic-hooks/navigate-hooks';
import {
  DocumentApiAction,
  useRunDocument,
  useSetDocumentStatus,
} from '@/hooks/use-document-request';
import { IDocumentInfo } from '@/interfaces/database/document';
import { cn } from '@/lib/utils';
import {
  getMetaDataService,
  updateMetaData,
} from '@/services/knowledge-service';
import { formatDate } from '@/utils/date';
import { useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/table-core';
import { ArrowUpDown, CircleX, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { MetadataType } from '../components/metedata/constant';
import { ShowManageMetadataModalProps } from '../components/metedata/interface';
import { DocumentType, RunningStatus } from './constant';
import { DatasetActionCell } from './dataset-action-cell';
import { ParseDropdownButton, ParsingStatusCell } from './parsing-status-cell';
import { UseChangeDocumentParserShowType } from './use-change-document-parser';
import { UseRenameDocumentShowType } from './use-rename-document';

type UseDatasetTableColumnsType = UseChangeDocumentParserShowType &
  UseRenameDocumentShowType & {
    documents: IDocumentInfo[];
    showLog: (record: IDocumentInfo) => void;
    showManageMetadataModal: (config: ShowManageMetadataModalProps) => void;
  };

export function useDatasetTableColumns({
  documents,
  showChangeParserModal,
  showRenameModal,
  showManageMetadataModal,
  showLog,
}: UseDatasetTableColumnsType) {
  const { t } = useTranslation('translation', {
    keyPrefix: 'knowledgeDetails',
  });
  const { t: tCommon } = useTranslation('translation', {
    keyPrefix: 'common',
  });
  // const { dataSourceInfo } = useDataSourceInfo();
  const { navigateToChunkParsedResult } = useNavigatePage();
  const { setDocumentStatus } = useSetDocumentStatus();
  const { runDocumentByIds } = useRunDocument();
  const { id: kbId } = useParams();
  const queryClient = useQueryClient();
  const runnableDocuments = documents.filter(
    (doc) => doc.type !== DocumentType.Virtual,
  );
  const enabledDocumentIds = documents
    .filter((doc) => doc.status === '1')
    .map((doc) => doc.id);
  const runningDocumentIds = runnableDocuments
    .filter(
      (doc) =>
        doc.run === RunningStatus.RUNNING || doc.run === RunningStatus.SCHEDULE,
    )
    .map((doc) => doc.id);
  const rerunDocumentIds = runnableDocuments
    .filter(
      (doc) =>
        doc.run !== RunningStatus.RUNNING && doc.run !== RunningStatus.SCHEDULE,
    )
    .map((doc) => doc.id);
  const emptyMetadataDocumentIds = runnableDocuments
    .filter(
      (doc) =>
        doc.run !== RunningStatus.RUNNING &&
        doc.run !== RunningStatus.SCHEDULE &&
        (!doc.meta_fields || Object.keys(doc.meta_fields).length === 0),
    )
    .map((doc) => doc.id);
  const allDocumentIds = documents.map((doc) => doc.id);
  const allEnabled =
    documents.length > 0 && enabledDocumentIds.length === documents.length;
  const isIntermediate =
    enabledDocumentIds.length > 0 &&
    enabledDocumentIds.length < documents.length;

  const handleClearMetadataForAllDocuments = useCallback(async () => {
    if (!kbId || allDocumentIds.length === 0) return;
    const { data: metadataRes } = await getMetaDataService({
      kb_id: kbId,
      doc_ids: allDocumentIds,
    });
    const keys = Object.keys(metadataRes?.data?.summary || {});
    if (keys.length === 0) {
      message.success(t('message.operated'));
      return;
    }
    const { data: updateRes } = await updateMetaData({
      kb_id: kbId,
      doc_ids: allDocumentIds,
      data: {
        deletes: keys.map((key) => ({ key })),
        updates: [],
      },
    });
    if (updateRes?.code === 0) {
      queryClient.invalidateQueries({
        queryKey: [DocumentApiAction.FetchDocumentList],
      });
      queryClient.invalidateQueries({
        queryKey: [DocumentApiAction.FetchDocumentFilter],
      });
      message.success(t('message.operated'));
    }
  }, [kbId, allDocumentIds, queryClient, t]);

  const columns: ColumnDef<IDocumentInfo>[] = [
    {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      accessorKey: 'name',
      header: ({ column }) => {
        return (
          <div className="flex items-center gap-1">
            {t('name')}

            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === 'asc')
              }
            >
              <ArrowUpDown />
            </Button>
          </div>
        );
      },
      meta: { cellClassName: 'max-w-[20vw]' },
      cell: ({ row }) => {
        const name: string = row.getValue('name');

        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="flex items-center gap-2 cursor-pointer"
                onClick={navigateToChunkParsedResult(
                  row.original.id,
                  row.original.kb_id,
                )}
              >
                <FileIcon name={name}></FileIcon>
                <span className={cn('truncate')}>{name}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{name}</p>
            </TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      accessorKey: 'create_time',
      header: ({ column }) => {
        return (
          <div className="flex items-center gap-1">
            {t('uploadDate')}

            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() =>
                column.toggleSorting(column.getIsSorted() === 'asc')
              }
            >
              <ArrowUpDown />
            </Button>
          </div>
        );
      },
      cell: ({ row }) => (
        <time
          className="lowercase"
          dateTime={new Date(row.getValue('create_time')).toISOString()}
        >
          {formatDate(row.getValue('create_time'))}
        </time>
      ),
    },
    /*
    {
      accessorKey: 'source_from',
      header: t('source'),
      cell: ({ row }) => (
        <div className="text-text-primary">
          {row.original.source_type === 'local' ||
          row.original.source_type === '' ? (
            <div className="bg-accent-primary-5 w-6 h-6 rounded-full flex items-center justify-center">
              <MonitorUp className="text-accent-primary" size={16} />
            </div>
          ) : (
            <div className="w-6 h-6 flex items-center justify-center">
              {
                dataSourceInfo[
                  row.original.source_type as keyof typeof dataSourceInfo
                ]?.icon
              }
            </div>
          )}
        </div>
      ),
    },
    */
    {
      accessorKey: 'status',
      header: () => (
        <div className="flex items-center gap-2">
          <span>{t('enabled')}</span>
          <Switch
            checked={allEnabled}
            intermediate={isIntermediate}
            disabled={documents.length === 0}
            onCheckedChange={(checked) => {
              setDocumentStatus({
                status: checked,
                documentId: allDocumentIds,
              });
            }}
          />
        </div>
      ),
      cell: ({ row }) => {
        const id = row.original.id;
        return (
          <Switch
            checked={row.getValue('status') === '1'}
            onCheckedChange={(e) => {
              setDocumentStatus({ status: e, documentId: id });
            }}
          />
        );
      },
    },
    {
      accessorKey: 'chunk_num',
      header: t('chunkNumber'),
      cell: ({ row }) => (
        <div className="capitalize">{row.getValue('chunk_num')}</div>
      ),
    },
    {
      accessorKey: 'meta_fields',
      header: () => (
        <div className="flex items-center gap-1">
          <span>{t('metadata.metadata')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <ConfirmDeleteDialog
                title={t('metadata.clearAllMetadata')}
                okButtonText={tCommon('clear')}
                onOk={handleClearMetadataForAllDocuments}
                content={{
                  title: t('metadata.clearAllMetadataConfirmTitle'),
                  node: (
                    <div>{t('metadata.clearAllMetadataConfirmContent')}</div>
                  ),
                }}
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={documents.length === 0}
                >
                  <Trash2 className="text-state-error" />
                </Button>
              </ConfirmDeleteDialog>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('metadata.clearAllMetadata')}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ),
      cell: ({ row }) => {
        const length = Object.keys(row.getValue('meta_fields') || {}).length;
        return (
          <Button
            variant="static"
            size="auto"
            onClick={() => {
              showManageMetadataModal({
                // metadata: util.JSONToMetaDataTableData(
                //   row.original.meta_fields || {},
                // ),
                isEditField: false,
                isCanAdd: true,
                isAddValue: true,
                type: MetadataType.UpdateSingle,
                record: row.original,
                title: (
                  <div className="flex flex-col gap-2 w-full">
                    <div className="text-base font-normal">
                      {t('metadata.editMetadata')}
                    </div>
                    {/* <div className="text-sm text-text-secondary w-full truncate">
                      {t('metadata.editMetadataForDataset')}
                      {row.original.name}
                    </div> */}
                  </div>
                ),
                secondTitle: (
                  <div className="w-full flex gap-1 text-sm text-text-secondary">
                    <FileIcon name={row.original.name}></FileIcon>
                    <div className="truncate">{row.original.name}</div>
                  </div>
                ),
                isDeleteSingleValue: true,
                documentIds: [row.original.id],
              });
            }}
          >
            {length + ' fields'}
          </Button>
        );
      },
    },
    {
      accessorKey: 'run',
      header: t('Parse'),
      // meta: { cellClassName: 'min-w-[20vw]' },
      cell: ({ row }) => {
        return (
          <ParseDropdownButton
            record={row.original}
            showChangeParserModal={showChangeParserModal}
          />
        );
      },
    },
    {
      id: 'run-status',
      header: () => (
        <div className="flex justify-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={rerunDocumentIds.length === 0}
                onClick={() =>
                  runDocumentByIds({
                    documentIds: rerunDocumentIds,
                    run: 1,
                  })
                }
              >
                <RotateCcw className="text-accent-primary" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('run')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={emptyMetadataDocumentIds.length === 0}
                onClick={() =>
                  runDocumentByIds({
                    documentIds: emptyMetadataDocumentIds,
                    run: 1,
                  })
                }
              >
                <Play className="text-accent-primary" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('runNoMetadata')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={runningDocumentIds.length === 0}
                onClick={() =>
                  runDocumentByIds({
                    documentIds: runningDocumentIds,
                    run: 2,
                  })
                }
              >
                <CircleX className="text-state-error" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('cancel')}</TooltipContent>
          </Tooltip>
        </div>
      ),
      cell: ({ row }) => {
        return (
          <ParsingStatusCell
            record={row.original}
            showChangeParserModal={showChangeParserModal}
            showLog={showLog}
          />
        );
      },
    },
    {
      id: 'actions',
      header: t('action'),
      enableHiding: false,
      cell: ({ row }) => {
        const record = row.original;

        return (
          <DatasetActionCell
            record={record}
            showRenameModal={showRenameModal}
          />
        );
      },
    },
  ];

  return columns;
}
