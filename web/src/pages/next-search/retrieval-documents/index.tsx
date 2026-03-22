import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useAllTestingResult,
  useChunkIsTesting,
  useSelectTestingResult,
} from '@/hooks/use-knowledge-request';
import {
  IAppliedMetaFilters,
  ITestingDocument,
} from '@/interfaces/database/knowledge';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Files, Filter, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface IProps {
  onTesting(documentIds: string[]): void;
  setSelectedDocumentIds(documentIds: string[]): void;
  selectedDocumentIds: string[];
  setLoading?: (loading: boolean) => void;
}

function formatFilterOp(op: string): string {
  const map: Record<string, string> = {
    '=': '=',
    '≠': '≠',
    '>': '>',
    '<': '<',
    '≥': '≥',
    '≤': '≤',
    contains: 'contains',
    'not contains': 'not contains',
    in: 'in',
    'not in': 'not in',
    'start with': 'starts with',
    'end with': 'ends with',
    empty: 'is empty',
    'not empty': 'is not empty',
  };
  return map[op] ?? op;
}

function MetaFilterTags({
  filters,
}: {
  filters: IAppliedMetaFilters | undefined;
}) {
  if (!filters?.conditions?.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      <Filter className="size-3.5 text-text-secondary shrink-0" />
      {filters.conditions.map((cond, idx) => (
        <Badge
          key={`${cond.key}-${idx}`}
          variant="secondary"
          className="text-xs font-normal gap-1 px-2 py-0.5"
        >
          <span className="font-medium">{cond.key}</span>
          <span className="text-text-secondary">{formatFilterOp(cond.op)}</span>
          <span>
            {Array.isArray(cond.value) ? cond.value.join(', ') : cond.value}
          </span>
        </Badge>
      ))}
      {filters.conditions.length > 1 && (
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          ({filters.logic})
        </span>
      )}
    </div>
  );
}

function MetadataCells({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return <span className="text-text-secondary text-xs">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => {
        const displayValue = Array.isArray(value)
          ? value.join(', ')
          : String(value ?? '');
        return (
          <span
            key={key}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-fill-tertiary"
          >
            <span className="font-medium text-text-secondary">{key}:</span>
            <span className="truncate max-w-[180px]" title={displayValue}>
              {displayValue}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function FileRow({
  doc,
  isSelected,
  onToggle,
}: {
  doc: ITestingDocument;
  isSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <tr
      className={cn(
        'border-b border-border-default/50 last:border-b-0 transition-colors hover:bg-fill-tertiary/50 cursor-pointer',
        isSelected && 'bg-accent-primary-5/50',
      )}
      onClick={onToggle}
    >
      <td className="px-2 py-1.5 w-8">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggle()}
          onClick={(e) => e.stopPropagation()}
          className="size-3.5"
        />
      </td>
      <td className="px-2 py-1.5 text-xs break-all max-w-[200px]">
        <span className="truncate block" title={doc.doc_name}>
          {doc.doc_name}
        </span>
      </td>
      <td className="px-2 py-1.5 text-xs text-center tabular-nums w-12">
        {doc.count}
      </td>
      <td className="px-2 py-1.5">
        <MetadataCells metadata={doc.matched_metadata ?? {}} />
      </td>
    </tr>
  );
}

const RetrievalDocuments = ({
  onTesting,
  selectedDocumentIds,
  setSelectedDocumentIds,
  setLoading,
}: IProps) => {
  const { documents: documentsAll, applied_meta_filters: filtersAll } =
    useAllTestingResult();
  const { documents, applied_meta_filters: filtersSelected } =
    useSelectTestingResult();
  const isTesting = useChunkIsTesting();
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    setLoading?.(isTesting);
  }, [isTesting, setLoading]);

  const useDocuments = useMemo(
    () => (documentsAll?.length > documents?.length ? documentsAll : documents),
    [documentsAll, documents],
  );

  const appliedFilters = filtersAll ?? filtersSelected;

  const [selectedValues, setSelectedValues] =
    useState<string[]>(selectedDocumentIds);

  const onValueChange = (value: string[]) => {
    onTesting(value);
    setSelectedDocumentIds(value);
  };

  const toggleOption = (docId: string) => {
    const next = selectedValues.includes(docId)
      ? selectedValues.filter((v) => v !== docId)
      : [...selectedValues, docId];
    setSelectedValues(next);
    onValueChange(next);
  };

  const handleClear = () => {
    setSelectedValues([]);
    onValueChange([]);
  };

  if (!useDocuments?.length) return null;

  return (
    <div className="w-full space-y-2">
      <MetaFilterTags filters={appliedFilters} />

      <div className="rounded-lg border border-border-default bg-bg-card overflow-hidden">
        <button
          type="button"
          onClick={() => setIsExpanded((p) => !p)}
          className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-fill-tertiary/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <Files className="size-4" />
            <span className="tabular-nums">
              {selectedDocumentIds?.length ?? 0}/{useDocuments.length}
            </span>
            <span>Files</span>
          </div>
          <div className="flex items-center gap-2">
            {selectedValues.length > 0 && (
              <XIcon
                className="size-3.5 text-text-secondary hover:text-text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClear();
                }}
              />
            )}
          </div>
        </button>

        {isExpanded && (
          <div className="border-t border-border-default">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border-default bg-fill-tertiary/30">
                  <th className="px-2 py-1 w-8"></th>
                  <th className="px-2 py-1 text-[11px] font-medium text-text-secondary uppercase tracking-wider">
                    File
                  </th>
                  <th className="px-2 py-1 text-[11px] font-medium text-text-secondary uppercase tracking-wider text-center w-12">
                    Hits
                  </th>
                  <th className="px-2 py-1 text-[11px] font-medium text-text-secondary uppercase tracking-wider">
                    Metadata
                  </th>
                </tr>
              </thead>
              <tbody>
                {useDocuments.map((doc) => (
                  <FileRow
                    key={doc.doc_id}
                    doc={doc}
                    isSelected={selectedValues.includes(doc.doc_id)}
                    onToggle={() => toggleOption(doc.doc_id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default RetrievalDocuments;
