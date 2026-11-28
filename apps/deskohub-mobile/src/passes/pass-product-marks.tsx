import { StyleSheet, View } from "react-native";
import { color } from "../ui/tokens";

/**
 * The two products as tiny marks (board 06): the beige Entry pack ticket
 * with its tear-off stub, and the burgundy Unlimited credential with its
 * photo area and foil stripe. Decorative: the text beside them names what
 * they lead to, so assistive technology skips them.
 */
export function PassProductMarks() {
  return (
    <View aria-hidden style={styles.marks}>
      <View style={[styles.mark, styles.ticket]}>
        <View style={styles.ticketBody} />
        <View style={styles.ticketStub} />
      </View>
      <View style={[styles.mark, styles.credential]}>
        <View style={styles.photo} />
        <View style={styles.foil}>
          <View style={[styles.foilPart, styles.foilFirst]} />
          <View style={[styles.foilPart, styles.foilMid]} />
          <View style={[styles.foilPart, styles.foilLast]} />
        </View>
      </View>
    </View>
  );
}

// The board draws each mark 1.43 by 0.94 of its 0.95rem text.
const markWidth = 22;
const markHeight = 14;

const styles = StyleSheet.create({
  marks: { alignItems: "center", flexDirection: "row", gap: 4 },
  mark: {
    borderRadius: 2,
    borderWidth: 1,
    height: markHeight,
    overflow: "hidden",
    width: markWidth,
  },
  ticket: { borderColor: color.ticketEdge, flexDirection: "row" },
  ticketBody: { backgroundColor: color.ticketPaper, flex: 69 },
  ticketStub: {
    backgroundColor: color.ticketStub,
    borderColor: color.ticketPerforation,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    flex: 31,
  },
  credential: {
    backgroundColor: color.credentialBase,
    borderColor: color.credentialEdge,
  },
  photo: {
    backgroundColor: color.credentialBadgeEdge,
    borderRadius: 1,
    height: "40%",
    left: "13%",
    position: "absolute",
    top: "27%",
    width: "24%",
  },
  foil: {
    flexDirection: "row",
    height: 1,
    position: "absolute",
    right: "13%",
    top: "18%",
    width: "34%",
  },
  foilPart: { flex: 1 },
  foilFirst: { backgroundColor: color.credentialFoilFirst },
  foilMid: { backgroundColor: color.credentialFoilMid },
  foilLast: { backgroundColor: color.credentialFoilLast },
});
