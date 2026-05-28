import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Clock,
  GitBranch,
  Loader2,
  Network,
  XCircle,
} from "lucide-react";
import * as React from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import type { FlowNode } from "@/core/types";
import { useFlow } from "@/lib/hooks";
import { formatDuration } from "@/lib/utils";

interface FlowPageProps {
  queueName: string;
  jobId: string;
}

export function FlowPage({ queueName, jobId }: FlowPageProps) {
  const navigate = useNavigate();
  const [expandedQueues, setExpandedQueues] = React.useState<Set<string>>(
    () => new Set(),
  );
  const { data: flow, isLoading, error } = useFlow(queueName, jobId);

  const handleNodeClick = (node: FlowNode) => {
    navigate({
      to: "/queues/$queueName/jobs/$jobId",
      params: { queueName: node.queueName, jobId: node.job.id },
    });
  };

  const stats = React.useMemo(
    () => (flow ? countFlowStats(flow) : { total: 0, completed: 0, failed: 0 }),
    [flow],
  );
  const childJobs = React.useMemo(
    () => collectDescendants(flow?.children ?? []),
    [flow?.children],
  );
  const childQueueGroups = React.useMemo(() => {
    const groups = new Map<string, FlowNode[]>();
    for (const child of childJobs) {
      const nodes = groups.get(child.queueName) ?? [];
      nodes.push(child);
      groups.set(child.queueName, nodes);
    }

    return Array.from(groups.entries())
      .map(([name, jobs]) => ({
        queueName: name,
        jobs,
      }))
      .sort((a, b) => b.jobs.length - a.jobs.length);
  }, [childJobs]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col h-full -mb-6">
        {/* Header skeleton */}
        <div className="pb-4 border-b border-border shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="h-6 w-32 animate-pulse rounded bg-muted" />
              <div className="h-5 w-20 animate-pulse rounded bg-muted" />
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          </div>
        </div>
        {/* Graph skeleton */}
        <div className="flex-1 -mx-6 -mb-6 mt-6 flex items-center justify-center dotted-bg">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Error state
  if (error || !flow) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Failed to load flow"
        description={
          (error as Error)?.message ||
          "Flow not found or jobs have been cleaned up"
        }
      />
    );
  }

  const toggleQueue = (queue: string) => {
    setExpandedQueues((prev) => {
      const next = new Set(prev);
      if (next.has(queue)) {
        next.delete(queue);
      } else {
        next.add(queue);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full -mb-6">
      {/* Header */}
      <div className="pb-4 border-b border-border shrink-0">
        {/* Title row */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Network className="h-5 w-5 text-muted-foreground" />
            <StatusBadge status={flow.job.status} />
          </div>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Queue:</span>
            <button
              type="button"
              onClick={() =>
                navigate({
                  to: "/queues/$queueName",
                  params: { queueName },
                })
              }
              className="text-xs bg-muted px-1.5 py-0.5 font-mono text-primary hover:underline"
            >
              {queueName}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">
              {stats.total} job{stats.total !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span className="text-muted-foreground">
              {stats.completed} completed
            </span>
          </div>
          {stats.failed > 0 && (
            <div className="flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              <span className="text-red-500">{stats.failed} failed</span>
            </div>
          )}
          {flow.job.duration !== undefined && (
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                {formatDuration(flow.job.duration)}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto mt-6 space-y-4">
        <div className="border border-dashed bg-card">
          <div className="border-b border-dashed px-4 py-3">
            <h3 className="text-sm font-medium">Parent Job Queue</h3>
          </div>
          <button
            type="button"
            onClick={() => handleNodeClick(flow)}
            className="w-full text-left px-4 py-3 hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{flow.job.name}</div>
                <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                  {flow.queueName}
                </div>
              </div>
              <StatusBadge status={flow.job.status} />
            </div>
          </button>
        </div>

        <div className="border border-dashed bg-card">
          <div className="border-b border-dashed px-4 py-3 flex items-center justify-between">
            <h3 className="text-sm font-medium">Child Queues</h3>
            <span className="text-xs text-muted-foreground">
              {childJobs.length} child jobs in {childQueueGroups.length} queues
            </span>
          </div>

          {childQueueGroups.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground text-center">
              No child queues found for this flow
            </div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {childQueueGroups.map((group) => {
                  const isExpanded = expandedQueues.has(group.queueName);

                  return (
                    <div key={group.queueName}>
                      <div className="px-4 py-3 flex items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => toggleQueue(group.queueName)}
                          className="flex items-center gap-2 min-w-0 text-left"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-sm font-mono truncate">
                            {group.queueName}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            ({group.jobs.length})
                          </span>
                        </button>

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            navigate({
                              to: "/queues/$queueName",
                              params: { queueName: group.queueName },
                            })
                          }
                        >
                          Open Queue
                        </Button>
                      </div>

                      {isExpanded && (
                        <div className="px-4 pb-3 space-y-2">
                          <div className="rounded border border-dashed divide-y divide-border">
                            {group.jobs.map((child) => (
                              <button
                                type="button"
                                key={`${child.queueName}:${child.job.id}`}
                                onClick={() => handleNodeClick(child)}
                                className="w-full text-left px-3 py-2 hover:bg-accent/50 transition-colors"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-sm truncate">
                                      {child.job.name}
                                    </div>
                                    <div className="text-xs text-muted-foreground font-mono truncate">
                                      {child.job.id}
                                    </div>
                                  </div>
                                  <StatusBadge status={child.job.status} />
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function collectDescendants(nodes: FlowNode[]): FlowNode[] {
  const result: FlowNode[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) continue;
    result.push(current);
    if (current.children?.length) {
      stack.push(...current.children);
    }
  }
  return result;
}

function countFlowStats(node: FlowNode): {
  total: number;
  completed: number;
  failed: number;
} {
  let total = 1;
  let completed = node.job.status === "completed" ? 1 : 0;
  let failed = node.job.status === "failed" ? 1 : 0;

  if (node.children) {
    for (const child of node.children) {
      const childStats = countFlowStats(child);
      total += childStats.total;
      completed += childStats.completed;
      failed += childStats.failed;
    }
  }

  return { total, completed, failed };
}
