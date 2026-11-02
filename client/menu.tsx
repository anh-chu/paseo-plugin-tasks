import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  onSelect: () => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MENU_WIDTH = 190;
const ITEM_HEIGHT = 32;

const MenuContext = createContext<
  ((anchor: Rect, items: MenuItem[]) => void) | null
>(null);

// Draws one dropdown at a time over its children, so menus opened inside
// scrolling columns are not clipped.
export function MenuProvider({
  theme,
  children,
}: {
  theme: PluginTheme;
  children: ReactNode;
}) {
  const root = useRef<View>(null);
  const [menu, setMenu] = useState<{
    anchor: Rect;
    origin: Rect;
    items: MenuItem[];
  } | null>(null);
  const open = useCallback((anchor: Rect, items: MenuItem[]) => {
    root.current?.measureInWindow((x, y, width, height) =>
      setMenu({ anchor, origin: { x, y, width, height }, items }),
    );
  }, []);

  let placement: { top: number; left: number; maxHeight: number } | null =
    null;
  if (menu) {
    const { anchor, origin, items } = menu;
    const height = Math.min(items.length * ITEM_HEIGHT + 10, 320);
    const below = anchor.y + anchor.height + 4 - origin.y;
    const fitsBelow = below + height <= origin.height - 4;
    placement = {
      top: fitsBelow ? below : Math.max(4, anchor.y - origin.y - 4 - height),
      left: Math.max(
        4,
        Math.min(anchor.x - origin.x, origin.width - MENU_WIDTH - 4),
      ),
      maxHeight: height,
    };
  }

  return (
    <View ref={root} style={{ flex: 1 }}>
      <MenuContext.Provider value={open}>{children}</MenuContext.Provider>
      {menu && placement ? (
        <>
          <Pressable
            accessibilityLabel="Close menu"
            onPress={() => setMenu(null)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 100,
            }}
          />
          <View
            accessibilityRole="menu"
            style={{
              position: "absolute",
              zIndex: 101,
              top: placement.top,
              left: placement.left,
              width: MENU_WIDTH,
              maxHeight: placement.maxHeight,
              padding: 4,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
              shadowColor: "#000",
              shadowOpacity: 0.16,
              shadowRadius: 14,
              shadowOffset: { width: 0, height: 6 },
            }}
          >
            <ScrollView>
              {menu.items.map((item) => (
                <Pressable
                  key={item.key}
                  accessibilityRole="menuitem"
                  onPress={() => {
                    setMenu(null);
                    item.onSelect();
                  }}
                  // react-native-web passes `hovered`; native types omit it.
                  style={(state) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    height: ITEM_HEIGHT,
                    paddingHorizontal: 8,
                    borderRadius: 6,
                    backgroundColor: (state as { hovered?: boolean }).hovered
                      ? theme.colors.surface2
                      : "transparent",
                  })}
                >
                  {item.icon}
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      color: theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: item.selected ? "700" : "500",
                    }}
                  >
                    {item.label}
                  </Text>
                  {item.selected ? (
                    <Icon
                      name="Check"
                      size={13}
                      color={theme.colors.foreground}
                    />
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </>
      ) : null}
    </View>
  );
}

export function MenuButton({
  items,
  accessibilityLabel,
  style,
  children,
}: {
  items: () => MenuItem[];
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const open = useContext(MenuContext);
  const trigger = useRef<View>(null);
  return (
    <Pressable
      ref={trigger}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={() =>
        trigger.current?.measureInWindow((x, y, width, height) =>
          open?.({ x, y, width, height }, items()),
        )
      }
      style={style}
    >
      {children}
    </Pressable>
  );
}
