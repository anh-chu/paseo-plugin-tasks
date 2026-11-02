import type { PluginTheme } from "@getpaseo/plugin";
import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { PanResponder, View } from "react-native";

export interface Point {
  x: number;
  y: number;
}

export interface BoardDrag {
  start(taskId: string, point: Point): void;
  move(point: Point): void;
  end(point: Point): void;
  cancel(): void;
}

// Mouse drags only: on touch the card's status menu moves it, and a pan
// would fight the column scroll.
export function DraggableCard({
  taskId,
  drag,
  cardRef,
  dragging,
  children,
}: {
  taskId: string;
  drag: BoardDrag;
  cardRef: (view: View | null) => void;
  dragging: boolean;
  children: ReactNode;
}) {
  const current = useRef({ taskId, drag });
  current.current = { taskId, drag };
  const mousePress = useRef(false);
  const active = useRef(false);
  useEffect(
    () => () => {
      if (active.current) current.current.drag.cancel();
    },
    [],
  );
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        mousePress.current && Math.hypot(g.dx, g.dy) >= 6,
      onPanResponderGrant: (e) => {
        active.current = true;
        current.current.drag.start(current.current.taskId, {
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        });
      },
      onPanResponderMove: (_e, g) => {
        if (active.current) current.current.drag.move({ x: g.moveX, y: g.moveY });
      },
      onPanResponderRelease: (e) => {
        mousePress.current = false;
        if (!active.current) return;
        active.current = false;
        current.current.drag.end({
          x: e.nativeEvent.pageX,
          y: e.nativeEvent.pageY,
        });
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        mousePress.current = false;
        if (!active.current) return;
        active.current = false;
        current.current.drag.cancel();
      },
    }),
  );
  return (
    <View
      ref={cardRef}
      {...pan.panHandlers}
      onPointerDown={(e) => {
        mousePress.current =
          e.nativeEvent.pointerType === "mouse" && e.nativeEvent.button === 0;
      }}
      onPointerUp={() => {
        mousePress.current = false;
      }}
      style={{ opacity: dragging ? 0.4 : 1 }}
    >
      {children}
    </View>
  );
}

// Where a dragged card will land in a column.
export function DropLine({ theme }: { theme: PluginTheme }) {
  return (
    <View
      style={{
        height: 2,
        marginVertical: -5,
        borderRadius: 1,
        backgroundColor: theme.colors.accent,
      }}
    />
  );
}
